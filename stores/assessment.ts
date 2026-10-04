import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";

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

export interface FieldChange {
  field: keyof Household;
  before: unknown;
  after: unknown;
}

export type ChangeAction = "新增" | "修改" | "合并" | "分派" | "状态流转";

export interface PendingChange {
  id: string;
  entity: string;
  action: ChangeAction;
  householdId?: string;
  baseVersion?: number;
  changes?: FieldChange[];
  detail: string;
  time: string;
}

export interface FieldConflict {
  id: string;
  householdId: string;
  field: keyof Household;
  localValue: unknown;
  remoteValue: unknown;
  status: "待处理" | "采用本地" | "采用远端";
}

const KEY = "pair-wise-yf-50/assessment";

const seedHouseholds: Household[] = [
  { id: "h1", head: "王建国", community: "河湾社区", address: "河湾路18号2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待复核", version: 2, deviceUpdatedAt: new Date(Date.now() - 12 * 60000).toISOString(), note: "一层受淹，老人行动不便" },
  { id: "h2", head: "赵敏", community: "新城社区", address: "新城三街9号", members: 2, vulnerable: [], needLevel: "一般", needs: ["饮用水"], status: "已分派", version: 1, deviceUpdatedAt: new Date(Date.now() - 35 * 60000).toISOString(), note: "饮水库存不足" },
  { id: "h3", head: "王建国", community: "河湾社区", address: "河湾路18号2幢2单元", members: 4, vulnerable: ["老人"], needLevel: "紧急", needs: ["临时安置", "慢病用药"], status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString(), note: "疑似重复登记" }
];
const seedTasks: FieldTask[] = [
  { id: "k1", householdId: "h2", title: "配送饮用水", assignee: "后勤二组", priority: "一般", status: "进行中", due: "2026-09-29 16:00" }
];

/** 服务端在离线期间可能改动的字段取值（用于模拟多人编辑同一记录）。 */
const FIELD_ALTERNATES: Partial<Record<keyof Household, unknown>> = {
  address: "河湾路18号2栋2单元",
  note: "远端补充：已联系社区物资点",
  needLevel: "高",
  members: 5,
  vulnerable: ["老人", "慢病患者"],
  needs: ["临时安置", "慢病用药", "饮用水"]
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function getField(obj: object, field: string): unknown {
  return (obj as unknown as Record<string, unknown>)[field];
}

function setField(obj: object, field: string, value: unknown): void {
  (obj as unknown as Record<string, unknown>)[field] = value;
}

/** 取一个与 current 不同的远端取值；该字段没有预设替代值时加后缀区分。 */
function differentValue(field: keyof Household, current: unknown): unknown {
  const value = FIELD_ALTERNATES[field];
  if (value === undefined) return `${String(current)}（远端）`;
  return value === current ? `${String(current)}（远端）` : value;
}

export const useAssessmentStore = defineStore("assessment", () => {
  const initial = typeof window !== "undefined" && localStorage.getItem(KEY) ? JSON.parse(localStorage.getItem(KEY)!) : null;
  const households = ref<Household[]>(initial?.households ?? seedHouseholds);
  const tasks = ref<FieldTask[]>(initial?.tasks ?? seedTasks);
  const queue = ref<PendingChange[]>(initial?.queue ?? []);
  const conflicts = ref<FieldConflict[]>(initial?.conflicts ?? []);
  // 服务端快照：按家庭保存已同步的基准状态，用于字段级三方合并
  const remote = ref<Record<string, { version: number; data: Household }>>(
    initial?.remote ?? Object.fromEntries(seedHouseholds.map((household) => [household.id, { version: household.version, data: clone(household) }]))
  );
  const online = ref(true);
  const lastSyncedAt = ref(initial?.lastSyncedAt ?? new Date().toISOString());
  const syncing = ref(false);

  const metrics = computed(() => ({
    households: households.value.length,
    urgent: households.value.filter((item) => item.needLevel === "紧急").length,
    openTasks: tasks.value.filter((item) => item.status !== "已完成").length,
    queued: queue.value.length
  }));

  const duplicates = computed(() => {
    const groups = new Map<string, Household[]>();
    households.value.forEach((household) => {
      const key = `${household.head}-${household.community}`;
      groups.set(key, [...(groups.get(key) ?? []), household]);
    });
    return [...groups.values()].filter((group) => group.length > 1);
  });

  function enqueue(entry: Omit<PendingChange, "id" | "time">) {
    queue.value.unshift({ ...entry, id: crypto.randomUUID(), time: new Date().toISOString() });
  }

  function addHousehold(input: Omit<Household, "id" | "status" | "version" | "deviceUpdatedAt">) {
    const household: Household = { ...input, id: crypto.randomUUID(), status: "待评估", version: 1, deviceUpdatedAt: new Date().toISOString() };
    households.value.unshift(household);
    enqueue({ entity: "家庭需求记录", action: "新增", householdId: household.id, detail: input.head });
  }

  function updateHousehold(id: string, patch: Partial<Household>) {
    const household = households.value.find((item) => item.id === id);
    if (!household) return;
    const changes: FieldChange[] = Object.entries(patch).map(([field, after]) => ({
      field: field as keyof Household,
      before: getField(household, field),
      after
    }));
    const baseVersion = household.version;
    Object.assign(household, patch, { version: household.version + 1, deviceUpdatedAt: new Date().toISOString() });
    // 需求等级变动 → 未完成任务的优先级随需求等级重算
    if (patch.needLevel) {
      tasks.value.forEach((task) => {
        if (task.householdId === id && task.status !== "已完成") task.priority = patch.needLevel as NeedLevel;
      });
    }
    enqueue({ entity: "家庭需求记录", action: "修改", householdId: id, baseVersion, changes, detail: `${household.head}：${Object.keys(patch).join("、")}` });
  }

  function mergeDuplicate(sourceId: string, targetId: string) {
    const source = households.value.find((item) => item.id === sourceId);
    const target = households.value.find((item) => item.id === targetId);
    if (!source || !target) return;
    const baseVersion = target.version;
    const changes: FieldChange[] = [
      { field: "needs", before: [...target.needs], after: Array.from(new Set([...target.needs, ...source.needs])) },
      { field: "vulnerable", before: [...target.vulnerable], after: Array.from(new Set([...target.vulnerable, ...source.vulnerable])) },
      { field: "note", before: target.note, after: `${target.note}；已合并重复记录 ${source.address}` }
    ];
    target.needs = changes[0].after as string[];
    target.vulnerable = changes[1].after as string[];
    target.note = changes[2].after as string;
    // 关联任务改指保留记录，避免任务随重复记录删除而失联
    tasks.value.forEach((task) => {
      if (task.householdId === sourceId) task.householdId = targetId;
    });
    target.version += 1;
    // 未完成任务还在 → 不能把家庭标成已完成
    const openTasks = tasks.value.some((task) => task.householdId === targetId && task.status !== "已完成");
    if (openTasks && target.status === "已完成") target.status = "已分派";
    households.value = households.value.filter((item) => item.id !== sourceId);
    enqueue({ entity: "重复记录", action: "合并", householdId: targetId, baseVersion, changes, detail: `${source.head} → ${target.address}` });
  }

  function addTask(input: Omit<FieldTask, "id" | "status">) {
    const task: FieldTask = { ...input, id: crypto.randomUUID(), status: "待接收" };
    tasks.value.unshift(task);
    const household = households.value.find((item) => item.id === input.householdId);
    if (household && household.status !== "已完成") household.status = "已分派";
    enqueue({ entity: "任务", action: "分派", householdId: input.householdId, detail: `${input.title} / ${input.assignee}` });
  }

  function advanceTask(id: string) {
    const task = tasks.value.find((item) => item.id === id);
    if (!task) return;
    task.status = task.status === "待接收" ? "进行中" : "已完成";
    if (task.status === "已完成") {
      const open = tasks.value.some((item) => item.householdId === task.householdId && item.status !== "已完成");
      const household = households.value.find((item) => item.id === task.householdId);
      if (household && !open) household.status = "已完成";
    }
    enqueue({ entity: "任务", action: "状态流转", householdId: task.householdId, detail: `${task.title} → ${task.status}` });
  }

  /** 生成服务端在离线期间对该记录的改动：一个与本地重叠的字段 + 一个未重叠字段。 */
  function remoteEditsFor(change: PendingChange, remoteData: Household): Record<string, unknown> {
    const edits: Record<string, unknown> = {};
    const localFields = (change.changes ?? []).map((item) => item.field);
    const overlap = localFields[0];
    if (overlap) {
      const before = change.changes!.find((item) => item.field === overlap)!.before;
      let remoteValue = differentValue(overlap, getField(remoteData, overlap as string));
      if (remoteValue === before) remoteValue = `${String(remoteValue)}（远端）`;
      edits[overlap as string] = remoteValue;
    }
    const candidates = (Object.keys(FIELD_ALTERNATES) as (keyof Household)[]).filter((field) => !localFields.includes(field));
    for (const field of candidates) {
      const value = differentValue(field, getField(remoteData, field as string));
      if (value !== getField(remoteData, field as string)) {
        edits[field as string] = value;
        break;
      }
    }
    return edits;
  }

  /** 字段级三方合并：改前值等于服务端现值 → 服务端没动，本地自动合并；同字段且取值不同 → 留两版待处理。 */
  function mergeHouseholdChange(change: PendingChange, newConflicts: FieldConflict[]): boolean {
    const id = change.householdId;
    if (!id) return true;
    const local = households.value.find((item) => item.id === id);
    if (!local) return true;
    if (!remote.value[id]) remote.value[id] = { version: local.version, data: clone(local) };
    const remoteHousehold = remote.value[id];
    const remoteEdits = remoteEditsFor(change, remoteHousehold.data);
    for (const [field, value] of Object.entries(remoteEdits)) {
      setField(remoteHousehold.data, field, value);
    }
    for (const fc of change.changes ?? []) {
      const remoteValue = getField(remoteHousehold.data, fc.field as string);
      if (remoteValue !== fc.before && remoteValue !== fc.after) {
        newConflicts.push({ id: crypto.randomUUID(), householdId: id, field: fc.field, localValue: fc.after, remoteValue, status: "待处理" });
      }
    }
    // 服务端快照保留远端版本；本地采用合并结果，冲突字段保留本地版本待人工二选一
    const merged = clone(remoteHousehold.data);
    for (const fc of change.changes ?? []) {
      setField(merged, fc.field as string, fc.after);
    }
    Object.assign(local, merged);
    local.version = remoteHousehold.version + 1;
    local.deviceUpdatedAt = new Date().toISOString();
    remoteHousehold.version = local.version;
    return true;
  }

  function simulateSync(): Promise<{ ok: boolean; processed: number; conflicts: number }> {
    if (!online.value) return Promise.resolve({ ok: false, processed: 0, conflicts: 0 });
    syncing.value = true;
    return new Promise((resolve) => {
      setTimeout(() => {
        try {
          // 模拟弱网中断：失败时不应用任何改动，队列原样保留，可直接重试
          if (Math.random() < 0.2) {
            resolve({ ok: false, processed: 0, conflicts: 0 });
            return;
          }
          const newConflicts: FieldConflict[] = [];
          const processed: string[] = [];
          for (const change of queue.value) {
            if (change.action === "新增") {
              const household = households.value.find((item) => item.id === change.householdId);
              if (household && !remote.value[household.id]) {
                remote.value[household.id] = { version: household.version, data: clone(household) };
              }
              processed.push(change.id);
            } else if (change.action === "修改" || change.action === "合并") {
              if (mergeHouseholdChange(change, newConflicts)) processed.push(change.id);
            } else {
              // 任务分派/状态流转：服务端已接收，直接确认
              processed.push(change.id);
            }
          }
          // 幂等：同一家庭同一字段已有待处理冲突时不重复生成
          let addedConflicts = 0;
          for (const conflict of newConflicts) {
            const duplicated = conflicts.value.some(
              (item) => item.householdId === conflict.householdId && item.field === conflict.field && item.status === "待处理"
            );
            if (!duplicated) {
              conflicts.value.unshift(conflict);
              addedConflicts += 1;
            }
          }
          queue.value = queue.value.filter((item) => !processed.includes(item.id));
          lastSyncedAt.value = new Date().toISOString();
          resolve({ ok: true, processed: processed.length, conflicts: addedConflicts });
        } finally {
          syncing.value = false;
        }
      }, 650);
    });
  }

  function resolveConflict(id: string, resolution: "采用本地" | "采用远端") {
    const conflict = conflicts.value.find((item) => item.id === id);
    if (!conflict) return;
    const household = households.value.find((item) => item.id === conflict.householdId);
    if (resolution === "采用远端" && household) {
      setField(household, conflict.field as string, conflict.remoteValue);
      const remoteHousehold = remote.value[conflict.householdId];
      if (remoteHousehold) setField(remoteHousehold.data, conflict.field as string, conflict.remoteValue);
    }
    conflict.status = resolution;
    if (household) {
      household.version += 1;
      const remoteHousehold = remote.value[conflict.householdId];
      if (remoteHousehold) remoteHousehold.version = household.version;
    }
  }

  if (typeof window !== "undefined") {
    watch([households, tasks, queue, conflicts, remote, lastSyncedAt], () => {
      localStorage.setItem(KEY, JSON.stringify({ households: households.value, tasks: tasks.value, queue: queue.value, conflicts: conflicts.value, remote: remote.value, lastSyncedAt: lastSyncedAt.value }));
    }, { deep: true });
  }

  return { households, tasks, queue, conflicts, remote, online, lastSyncedAt, syncing, metrics, duplicates, addHousehold, updateHousehold, mergeDuplicate, addTask, advanceTask, simulateSync, resolveConflict, enqueue };
});
