import type { HouseholdStatus } from "~/stores/assessment";

/** 队列里每条改动都细到字段：字段名、改前值（基准）、改后值 */
export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** 深比较两个值是否一致（数组/对象按内容比较） */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/** 队列与冲突面板里可读的值展示 */
export function displayValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "（空）";
  if (Array.isArray(value)) return value.length ? value.map(displayValue).join("、") : "（空）";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export const FIELD_LABELS: Record<string, string> = {
  head: "户主姓名",
  community: "社区",
  address: "地址",
  members: "家庭人数",
  vulnerable: "特殊照护",
  needLevel: "需求等级",
  needs: "主要需求",
  status: "记录状态",
  note: "现场说明",
  priority: "任务优先级",
  mergedFrom: "合并来源"
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export interface FieldConflictSeed {
  field: string;
  baseValue: unknown;
  localValue: unknown;
  remoteValue: unknown;
}

export interface AppliedField {
  field: string;
  value: unknown;
}

export interface MergeTriage {
  /** 远端没动过该字段，本地改动可直接上传（不同字段自动合并） */
  applied: AppliedField[];
  /** 远端结果与本地改后值已一致，无需再传 */
  converged: string[];
  /** 同事改了、本地没碰的字段，直接拉到本地 */
  pulled: Record<string, unknown>;
  /** 同字段双方都改了且结果不同，留两版待人工处理 */
  conflicts: FieldConflictSeed[];
}

const META_FIELDS = new Set(["id", "version", "deviceUpdatedAt"]);

/**
 * 基于“改前值（基准版本）”的字段级三路合并：
 * - 远端值 == 改前值：远端未改，本地自动合并
 * - 远端值 == 改后值：双方改到一起，天然收敛
 * - 本地没碰、远端改了：拉取远端
 * - 同字段双方都改且不同：产生冲突，不静默覆盖
 */
export function triageMerge(
  changes: FieldChange[],
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
  forceOverride = false
): MergeTriage {
  const result: MergeTriage = { applied: [], converged: [], pulled: {}, conflicts: [] };
  const edited = new Set<string>();

  for (const change of changes) {
    edited.add(change.field);
    const remoteValue = remote[change.field];
    if (forceOverride) {
      result.applied.push({ field: change.field, value: change.newValue });
    } else if (sameValue(remoteValue, change.oldValue)) {
      result.applied.push({ field: change.field, value: change.newValue });
    } else if (sameValue(remoteValue, change.newValue)) {
      result.converged.push(change.field);
    } else {
      result.conflicts.push({
        field: change.field,
        baseValue: change.oldValue,
        localValue: change.newValue,
        remoteValue
      });
    }
  }

  for (const key of Object.keys(remote)) {
    if (META_FIELDS.has(key) || edited.has(key)) continue;
    if (!sameValue(local[key], remote[key])) result.pulled[key] = remote[key];
  }

  return result;
}

/** 只要还有未完成任务，家庭就不允许停留在“已完成” */
export function ensureNotCompleted(status: HouseholdStatus, openTaskCount: number): HouseholdStatus {
  if (openTaskCount > 0 && status === "已完成") return "已分派";
  return status;
}
