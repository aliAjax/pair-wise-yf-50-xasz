import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  ensureNotCompleted,
  sameValue,
  triageMerge,
  type FieldChange
} from "~/utils/merge";

export type HouseholdStatus = "待评估" | "待复核" | "已分派" | "已完成";
export type NeedLevel = "紧急" | "高" | "一般";
export type TaskStatus = "待接收" | "进行中" | "已完成";

export interface Household {
  id: string;
  head: string;
  community: string;
  address: string;
  members: number;
  vulnerable: string[];
  needLevel: NeedLevel;
  needs: string[];
  status: HouseholdStatus;
  version: number;
  deviceUpdatedAt: string;
  note: string;
}

export interface FieldTask {
  id: string;
  householdId: string;
  title: string;
  assignee: string;
  priority: NeedLevel;
  status: TaskStatus;
  due: string;
}

export type QueueEntity = "家庭需求记录" | "重复记录" | "任务";
export type QueueAction = "新增" | "修改" | "合并" | "分派" | "状态流转" | "优先级重算";
export type QueueStatus = "待上传" | "上传失败" | "待处理冲突";

/**
 * 队列条目：记住每个字段的改前值（基准版本上的值）与改后值，
 * 回网后按字段三路合并，而不是整条覆盖别人。
 */
export interface PendingChange {
  id: string;
  entity: QueueEntity;
  action: QueueAction;
  detail: string;
  time: string;
  status: QueueStatus;
  retries: number;
  entityId: string;
  /** 基准（上次同步时）版本号 */
  baseVersion: number;
  /** 字段级改动 */
  fields: FieldChange[];
  /** 冲突解决后强制采用本机值（远端冲突字段直接覆盖） */
  forceOverride?: boolean;
  /** 新增记录的首版快照 */
  snapshot?: unknown;
  /** 合并操作所需的附属信息（被删记录 id、合并后的状态） */
  meta?: { sourceId?: string; status?: HouseholdStatus };
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: string;
  /** 基准值 / 本机改后值 / 远端值：同字段两版都保留 */
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
  localVersion: number;
  remoteVersion: number;
  status: "待处理" | "采用本地" | "采用远端";
  /** 关联的队列条目，解决后把决定补传 */
  changeId: string;
}

const KEY = "pair-wise-yf-50/assessment";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

/**
 * 模拟服务器端基线：同事在你离线期间改了 h1 的地址（与本机冲突字段）
 * 和现场说明（与本机不同字段，应自动合并）。
 */
function seedRemoteHouseholds(): Household[] {
  return seedHouseholds.slice(0, 2).map((item) => {
    if (item.id !== "h1") return clone(item);
    return {
      ...clone(item),
      address: "河湾路18号2栋2单元",
      vulnerable: ["老人", "孕妇"],
      version: 3
    };
  });
}

function normalizeQueue(raw: Partial<PendingChange>[] | undefined): PendingChange[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item.entityId === "string" && Array.isArray(item.fields))
    .map((item) => ({
      id: item.id!,
      entity: item.entity as QueueEntity,
      action: item.action as QueueAction,
      detail: item.detail ?? "",
      time: item.time ?? new Date().toISOString(),
      status: item.status === "待处理冲突" ? "待处理冲突" : "待上传",
      retries: typeof item.retries === "number" ? item.retries : 0,
      entityId: item.entityId!,
      baseVersion: typeof item.baseVersion === "number" ? item.baseVersion : 0,
      fields: item.fields!.map((field) => ({ field: field.field, oldValue: field.oldValue, newValue: field.newValue })),
      forceOverride: Boolean(item.forceOverride),
      snapshot: item.snapshot,
      meta: item.meta
    }));
}

function normalizeConflicts(raw: Partial<FieldConflict>[] | undefined): FieldConflict[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && item.id && item.householdId && item.field)
    .map((item) => ({
      id: item.id!,
      householdId: item.householdId!,
      field: item.field!,
      baseValue: item.baseValue,
      localValue: item.localValue,
      remoteValue: item.remoteValue,
      localVersion: typeof item.localVersion === "number" ? item.localVersion : 0,
      remoteVersion: typeof item.remoteVersion === "number" ? item.remoteVersion : 0,
      status: item.status === "采用本地" || item.status === "采用远端" ? item.status : "待处理",
      changeId: item.changeId ?? ""
    }));
}

export const useAssessmentStore = defineStore("assessment", () => {
  let persisted: {
    households?: Household[];
    tasks?: FieldTask[];
    queue?: Partial<PendingChange>[];
    conflicts?: Partial<FieldConflict>[];
    remoteHouseholds?: Household[];
    remoteTasks?: FieldTask[];
    lastSyncedAt?: string;
  } | null = null;
  if (typeof window !== "undefined") {
    try {
      persisted = JSON.parse(localStorage.getItem(KEY) || "null");
    } catch {
      persisted = null;
    }
  }

  const households = ref<Household[]>(persisted?.households ?? clone(seedHouseholds));
  const tasks = ref<FieldTask[]>(persisted?.tasks ?? clone(seedTasks));
  const queue = ref<PendingChange[]>(normalizeQueue(persisted?.queue));
  const conflicts = ref<FieldConflict[]>(normalizeConflicts(persisted?.conflicts));
  /** 模拟服务器端最新数据，用于回网合并 */
  const remoteHouseholds = ref<Household[]>(persisted?.remoteHouseholds ?? seedRemoteHouseholds());
  const remoteTasks = ref<FieldTask[]>(persisted?.remoteTasks ?? clone(seedTasks));
  const online = ref(true);
  /** 下一次同步是否模拟网络故障（演示失败后队列保留重试） */
  const failNextSync = ref(false);
  const lastSyncedAt = ref(persisted?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);
  const syncMessage = ref("");

  const openTaskCount = (householdId: string) =>
    tasks.value.filter((task) => task.householdId === householdId && task.status !== "已完成").length;

  /** 需求等级变更后，重算关联的未完成任务优先级（已完成任务不改） */
  function cascadeNeedLevel(householdId: string, level: NeedLevel) {
    const affected = tasks.value.filter(
      (task) => task.householdId === householdId && task.status !== "已完成" && task.priority !== level
    );
    for (const task of affected) {
      const oldLevel = task.priority;
      task.priority = level;
      enqueue("任务", "优先级重算", `${task.title}：${oldLevel} → ${level}`, task.id, 0, [
        { field: "priority", oldValue: oldLevel, newValue: level }
      ]);
    }
  }

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length,
    blocked: queue.value.filter((item) => item.status === "待处理冲突").length,
    failed: queue.value.filter((item) => item.status === "上传失败").length
  }));

  const pendingConflicts = computed(() => conflicts.value.filter((item) => item.status === "待处理"));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function enqueue(
    entity: QueueEntity,
    action: QueueAction,
    detail: string,
    entityId: string,
    baseVersion: number,
    fields: FieldChange[],
    extra?: Partial<PendingChange>
  ): PendingChange {
    const change: PendingChange = {
      id: crypto.randomUUID(),
      entity,
      action,
      detail,
      time: new Date().toISOString(),
      status: "待上传",
      retries: 0,
      entityId,
      baseVersion,
      fields: fields.map((field) => ({ ...field })),
      ...extra
    };
    queue.value.unshift(change);
    return change;
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    const household: Household = {
      ...input,
      id: crypto.randomUUID(),
      status: "待评估",
      version: 1,
      deviceUpdatedAt: new Date().toISOString()
    };
    households.value.unshift(household);
    enqueue("家庭需求记录", "新增", input.head, household.id, 0, [], {
      snapshot: clone(household),
      meta: { status: household.status }
    });
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;

    const before = clone(household);
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });

    const fieldChanges: FieldChange[] = [];
    for (const [field, newValue] of Object.entries(patch)) {
      if (!sameValue(before[field as keyof Household] as unknown, newValue)) {
        fieldChanges.push({ field, oldValue: before[field as keyof Household], newValue });
      }
    }
    if (!fieldChanges.length) return;

    const fieldNames = fieldChanges.map((change) => change.field);
    // 合并到同一条未上传修改：改前值取首次基准，基准版本保持不变
    const existing = queue.value.find(
      (item) =>
        item.entity === "家庭需求记录" &&
        item.action === "修改" &&
        item.entityId === id &&
        item.status !== "待处理冲突" &&
        !item.forceOverride
    );
    if (existing) {
      for (const change of fieldChanges) {
        const prior = existing.fields.find((field) => field.field === change.field);
        if (prior) prior.newValue = change.newValue;
        else existing.fields.push(change);
      }
      existing.detail = `${household.head}：${existing.fields.map((field) => field.field).join("、")}`;
      existing.time = new Date().toISOString();
    } else {
      enqueue(
        "家庭需求记录",
        "修改",
        `${household.head}：${fieldNames.join("、")}`,
        id,
        before.version,
        fieldChanges
      );
    }

    if (patch.needLevel && patch.needLevel !== before.needLevel) {
      cascadeNeedLevel(id, patch.needLevel);
    }
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;

    const before = clone(target);
    const mergedNeeds = Array.from(new Set([...target.needs, ...source.needs]));
    const mergedVulnerable = Array.from(new Set([...target.vulnerable, ...source.vulnerable]));
    const mergedNote = `${target.note}；已合并重复记录 ${source.address}`;
    Object.assign(target, {
      needs: mergedNeeds,
      vulnerable: mergedVulnerable,
      note: mergedNote,
      version: Math.max(target.version, source.version) + 1,
      deviceUpdatedAt: new Date().toISOString()
    });

    // 被合并记录的关联任务全部改指保留记录
    tasks.value.forEach((task) => {
      if (task.householdId === sourceId) task.householdId = targetId;
    });
    // 迁移过来的未完成任务仍在，家庭不能标成已完成
    target.status = ensureNotCompleted(target.status, openTaskCount(targetId));

    households.value = households.value.filter((item) => item.id !== sourceId);
    // 被合并记录的残留改动不再单独上传（其需求/照护已并入保留记录）
    queue.value = queue.value.filter(
      (item) => !(item.entityId === sourceId && item.action !== "合并")
    );

    enqueue("重复记录", "合并", `${source.head} → ${target.address}`, targetId, before.version, [
      { field: "needs", oldValue: before.needs, newValue: mergedNeeds },
      { field: "vulnerable", oldValue: before.vulnerable, newValue: mergedVulnerable },
      { field: "note", oldValue: before.note, newValue: mergedNote },
      { field: "status", oldValue: before.status, newValue: target.status },
      { field: "mergedFrom", oldValue: null, newValue: sourceId }
    ], { meta: { sourceId, status: target.status } });
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    const task: FieldTask = { ...input, id: crypto.randomUUID(), status: "待接收" };
    tasks.value.unshift(task);
    const household = households.value.find((item) => item.id === input.householdId);
    let statusFrom: HouseholdStatus | undefined;
    let statusTo: HouseholdStatus | undefined;
    if (household && household.status !== "已分派") {
      statusFrom = household.status;
      statusTo = "已分派";
      household.status = "已分派";
      household.version += 1;
      household.deviceUpdatedAt = new Date().toISOString();
    }
    enqueue("任务", "分派", `${input.title} / ${input.assignee}`, task.id, 0, [
      { field: "householdId", oldValue: null, newValue: input.householdId },
      { field: "title", oldValue: null, newValue: input.title },
      { field: "assignee", oldValue: null, newValue: input.assignee },
      { field: "priority", oldValue: null, newValue: input.priority },
      { field: "due", oldValue: null, newValue: input.due }
    ], { snapshot: clone(task) });

    // 新增未完成任务时家庭同样不能停留在已完成（上面的状态提升已覆盖，这里兜底）
    if (household) household.status = ensureNotCompleted(household.status, openTaskCount(household.id));
    if (statusFrom !== statusTo && household) {
      enqueue("家庭需求记录", "修改", `${household.head}：status`, household.id, household.version - 1, [
        { field: "status", oldValue: statusFrom, newValue: "已分派" }
      ]);
    }
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    const oldStatus = task.status;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    enqueue("任务", "状态流转", `${task.title} → ${task.status}`, task.id, 0, [
      { field: "status", oldValue: oldStatus, newValue: task.status }
    ]);

    if (task.status === "已完成") {
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && openTaskCount(household.id) === 0 && household.status !== "已完成") {
        const oldHouseholdStatus = household.status;
        household.status = "已完成";
        household.version += 1;
        household.deviceUpdatedAt = new Date().toISOString();
        enqueue("家庭需求记录", "修改", `${household.head}：status`, household.id, household.version - 1, [
          { field: "status", oldValue: oldHouseholdStatus, newValue: "已完成" }
        ]);
      }
    }
  }

  /** 把全部任务与家庭状态镜像到模拟服务器（新增任务在远端可能不存在） */
  function mirrorTasksToRemote() {
    for (const task of tasks.value) {
      const remote = remoteTasks.value.find((item) => item.id === task.id);
      if (remote) Object.assign(remote, clone(task));
      else remoteTasks.value.unshift(clone(task));
    }
  }

  /** 同一条队列 + 同一字段只保留一个待处理冲突，重复点同步不会多出冲突 */
  function hasPendingConflict(changeId: string, field: string): boolean {
    return conflicts.value.some(
      (item) => item.status === "待处理" && item.changeId === changeId && item.field === field
    );
  }

  /**
   * 回网同步：按队列逐条向模拟服务器提交并做字段级三路合并。
   * - 网络故障：一条都不丢，标记失败次数后保留，稍后重试
   * - 成功上传的条目才移除，绝不整条清空队列
   * - 不同字段自动合并，同字段冲突留两版待人工处理
   * - 重复点击/重复重试：冲突按“队列条目+字段”去重
   */
  async function simulateSync(forceFail = false): Promise<void> {
    if (syncing.value) return;
    if (!online.value) {
      syncMessage.value = "仍在弱网状态，队列保留在设备中，恢复网络后可继续重试。";
      return;
    }
    syncing.value = true;
    syncMessage.value = "正在按字段合并离线变更…";
    const willFail = forceFail || failNextSync.value;
    failNextSync.value = false;
    await new Promise((resolve) => setTimeout(resolve, 650));

    if (willFail) {
      for (const item of queue.value) {
        item.status = "上传失败";
        item.retries += 1;
      }
      syncing.value = false;
      syncMessage.value = `同步失败（网络故障），${queue.value.length} 条改动全部保留，可立即重试。`;
      return;
    }

    let autoMerged = 0;
    let conflictAdded = 0;
    // unshift 入队，倒序处理保证最早的改动先提交
    for (const item of [...queue.value].reverse()) {
      const household = households.value.find((entry) => entry.id === item.entityId);
      const remote = remoteHouseholds.value.find((entry) => entry.id === item.entityId);

      if (item.entity === "家庭需求记录" && item.action === "新增") {
        if (!remote && item.snapshot) remoteHouseholds.value.unshift(clone(item.snapshot as Household));
        queue.value = queue.value.filter((queued) => queued.id !== item.id);
        autoMerged += 1;
        continue;
      }

      if (item.entity === "重复记录" && item.action === "合并") {
        const sourceId = item.meta?.sourceId;
        if (sourceId) {
          remoteHouseholds.value = remoteHouseholds.value.filter((entry) => entry.id !== sourceId);
          remoteTasks.value.forEach((task) => {
            if (task.householdId === sourceId && remote) task.householdId = remote.id;
          });
        }
        if (remote && household) {
          for (const change of item.fields.filter((field) => field.field !== "mergedFrom")) {
            (remote as unknown as Record<string, unknown>)[change.field] = clone(change.newValue);
          }
          remote.version = Math.max(remote.version, household.version) + 1;
        }
        // 先镜像本地任务（可能含仅在本机新建、已改指到保留记录的任务），再做完成守卫
        mirrorTasksToRemote();
        if (remote) {
          const openRemote = remoteTasks.value.filter(
            (task) => task.householdId === remote.id && task.status !== "已完成"
          ).length;
          remote.status = ensureNotCompleted(item.meta?.status ?? remote.status, openRemote);
        }
        queue.value = queue.value.filter((queued) => queued.id !== item.id);
        autoMerged += 1;
        continue;
      }

      if (item.entity === "任务") {
        const task = tasks.value.find((entry) => entry.id === item.entityId);
        if (task) {
          const remoteTask = remoteTasks.value.find((entry) => entry.id === task.id);
          if (remoteTask) Object.assign(remoteTask, clone(task));
          else remoteTasks.value.unshift(clone(task));
          if (item.action === "状态流转" && task.status === "已完成") {
            const remoteHousehold = remoteHouseholds.value.find((entry) => entry.id === task.householdId);
            const open = remoteTasks.value.some(
              (entry) => entry.householdId === task.householdId && entry.status !== "已完成"
            );
            if (remoteHousehold) remoteHousehold.status = open ? remoteHousehold.status : "已完成";
          }
        }
        queue.value = queue.value.filter((queued) => queued.id !== item.id);
        autoMerged += 1;
        continue;
      }

      // 家庭记录“修改”：基于改前值的三路合并
      if (!household) {
        // 记录本地已删除（如已被合并），残留修改无法提交，直接丢弃
        queue.value = queue.value.filter((queued) => queued.id !== item.id);
        autoMerged += 1;
        continue;
      }
      if (!remote) {
        remoteHouseholds.value.unshift(clone(household));
        queue.value = queue.value.filter((queued) => queued.id !== item.id);
        autoMerged += 1;
        continue;
      }

      const triage = triageMerge(
        item.fields,
        household as unknown as Record<string, unknown>,
        remote as unknown as Record<string, unknown>,
        item.forceOverride
      );

      // 自动合并：把本地改的字段写到远端
      for (const applied of triage.applied) {
        (remote as unknown as Record<string, unknown>)[applied.field] = clone(applied.value);
      }
      // 远端更新但本机没碰的字段，拉到本地
      for (const [field, value] of Object.entries(triage.pulled)) {
        (household as unknown as Record<string, unknown>)[field] = clone(value);
      }
      // 拉来的新需求等级静默对齐未完成任务优先级（属于远端结果，不再排队）
      if (Object.prototype.hasOwnProperty.call(triage.pulled, "needLevel")) {
        tasks.value.forEach((task) => {
          if (task.householdId === household.id && task.status !== "已完成") {
            task.priority = household.needLevel;
          }
        });
      }

      // 同字段双方都改：留两版待人工处理（去重，重复同步不再新增）
      for (const seed of triage.conflicts) {
        if (hasPendingConflict(item.id, seed.field)) continue;
        conflicts.value.unshift({
          id: crypto.randomUUID(),
          householdId: household.id,
          field: seed.field,
          baseValue: seed.baseValue,
          localValue: seed.localValue,
          remoteValue: seed.remoteValue,
          localVersion: household.version,
          remoteVersion: remote.version,
          status: "待处理",
          changeId: item.id
        });
        conflictAdded += 1;
      }

      const remaining: FieldChange[] = item.fields.filter((change) =>
        triage.conflicts.some((seed) => seed.field === change.field && hasPendingConflict(item.id, change.field))
      );

      if (remaining.length) {
        item.fields = remaining;
        item.status = "待处理冲突";
      } else {
        // 所有字段都已自动合并或天然收敛；远端采纳了改动才升版本
        remote.version = Math.max(remote.version, household.version) + (triage.applied.length ? 1 : 0);
        queue.value = queue.value.filter((queued) => queued.id !== item.id);
        autoMerged += 1;
      }
    }

    // 等级重算等任务改动也要镜像，保证远端任务优先级一致
    mirrorTasksToRemote();

    lastSyncedAt.value = new Date().toISOString();
    syncing.value = false;
    if (conflictAdded) {
      syncMessage.value = `同步完成：${autoMerged} 条自动合并，${conflictAdded} 个同字段冲突保留两版待人工处理，其余改动仍在队列。`;
    } else if (queue.value.length) {
      syncMessage.value = `同步完成：${autoMerged} 条已提交，队列仍保留 ${queue.value.length} 条待处理改动。`;
    } else {
      syncMessage.value = "同步完成，全部离线改动已按字段合并，队列已清空。";
    }
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict || conflict.status !== "待处理") return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (!household) return;

    const before = clone(household);
    if (resolution === "采用远端") {
      (household as unknown as Record<string, unknown>)[conflict.field] = clone(conflict.remoteValue);
    } else {
      (household as unknown as Record<string, unknown>)[conflict.field] = clone(conflict.localValue);
    }
    household.version = Math.max(household.version, conflict.remoteVersion, conflict.localVersion) + 1;
    household.deviceUpdatedAt = new Date().toISOString();
    conflict.status = resolution;

    if (resolution === "采用远端" && conflict.field === "needLevel") {
      cascadeNeedLevel(household.id, household.needLevel);
    }

    const linked = queue.value.find((item) => item.id === conflict.changeId);
    if (linked) linked.fields = linked.fields.filter((field) => field.field !== conflict.field);

    // 采用本机：保留一条带基准的补传条目，下次同步强推；采用远端则无需上传
    if (resolution === "采用本地") {
      enqueue(
        "家庭需求记录",
        "修改",
        `${household.head}：${conflict.field}（冲突处理）`,
        household.id,
        before.version,
        [{ field: conflict.field, oldValue: conflict.baseValue, newValue: conflict.localValue }],
        { forceOverride: true }
      );
    }

    // 关联条目已无未决字段则移除
    if (linked && linked.fields.length === 0) {
      queue.value = queue.value.filter((item) => item.id !== linked.id);
    } else if (linked) {
      linked.status = "待处理冲突";
    }
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, conflicts, remoteHouseholds, remoteTasks, lastSyncedAt], () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          households: households.value,
          tasks: tasks.value,
          queue: queue.value,
          conflicts: conflicts.value,
          remoteHouseholds: remoteHouseholds.value,
          remoteTasks: remoteTasks.value,
          lastSyncedAt: lastSyncedAt.value
        })
      );
    }, { deep: true });
  }

  return {
    households,
    tasks,
    queue,
    conflicts,
    pendingConflicts,
    remoteHouseholds,
    remoteTasks,
    online,
    failNextSync,
    lastSyncedAt,
    syncing,
    syncMessage,
    metrics,
    duplicates,
    openTaskCount,
    addHousehold,
    updateHousehold,
    mergeDuplicate,
    addTask,
    advanceTask,
    simulateSync,
    resolveConflict,
    enqueue
  };
});
