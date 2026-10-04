import { JSDOM } from "jsdom";
import { setActivePinia, createPinia } from "pinia";
import { unref } from "vue";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
(globalThis as any).localStorage = dom.window.localStorage;
const KEY = "pair-wise-yf-50/assessment";
const KEYS = {
  passed: 0,
  check(name: string, cond: boolean) {
    if (cond) {
      this.passed++;
      console.log(`PASS  ${name}`);
    } else {
      console.error(`FAIL  ${name}`);
      process.exitCode = 1;
    }
  }
};

async function freshStore() {
  localStorage.removeItem(KEY);
  setActivePinia(createPinia());
  const store = await useStore();
  return U(store);
}

const REFS = new Set(["households","tasks","queue","conflicts","pendingConflicts","remoteHouseholds","remoteTasks","online","failNextSync","lastSyncedAt","syncing","syncMessage","metrics","duplicates"]);
function U(store: any) {
  return new Proxy(store, {
    get(target, prop) {
      const v = target[prop];
      if (typeof prop === "string" && REFS.has(prop)) return unref(v);
      return typeof v === "function" ? v.bind(target) : v;
    }
  });
}


async function useStore() {
  const mod: any = await import("../stores/assessment.ts");
  return mod.useAssessmentStore() as Awaited<ReturnType<typeof mod.useAssessmentStore>>;
}

// 1. 字段级队列：字段 / 改前值 / 基准版本
{
  const s = await freshStore();
  const h1 = s.households.find((h: any) => h.id === "h1");
  const oldNote = h1.note;
  s.updateHousehold("h1", { note: "改后的现场说明" });
  const q = s.queue[0];
  KEYS.check("队列条目记录字段名/改前值/改后值", q.fields[0].field === "note" && q.fields[0].oldValue === oldNote && q.fields[0].newValue === "改后的现场说明");
  KEYS.check("队列条目记录基准版本", q.baseVersion === 2);

  // 2. 不同字段自动合并 + 同字段留两版
  s.updateHousehold("h1", { address: "本机新地址" });
  await s.simulateSync();
  const h1After = s.households.find((h: any) => h.id === "h1");
  const remote = s.remoteHouseholds.find((h: any) => h.id === "h1");
  const conflict = s.conflicts.find((c: any) => c.field === "address");
  KEYS.check("不同字段(note)自动合并到远端", remote.note === "改后的现场说明");
  KEYS.check("本机未改字段(vulnerable)从远端拉取", JSON.stringify(h1After.vulnerable) === JSON.stringify(["老人", "孕妇"]));
  KEYS.check("同字段(address)产生冲突且保留两版", Boolean(conflict) && conflict.localValue === "本机新地址" && conflict.remoteValue === "河湾路18号2栋2单元");
  KEYS.check("同步没有整队清空，冲突条目仍在队列", s.queue.some((i: any) => i.status === "待处理冲突"));
  KEYS.check("冲突包含基准(改前)值", conflict.baseValue === "河湾路18号2单元");

  // 4b. 重复点同步不会多出冲突
  await s.simulateSync();
  KEYS.check("再次同步不会重复生成同字段冲突", s.conflicts.filter((c: any) => c.field === "address" && c.status === "待处理").length === 1);

  // 冲突解决：采用本机并补传
  s.resolveConflict(conflict.id, "采用本地");
  KEYS.check("解决后生成强推补传条目", s.queue.some((i: any) => i.forceOverride));
  await s.simulateSync();
  const remote2 = s.remoteHouseholds.find((h: any) => h.id === "h1");
  KEYS.check("补传后远端采用本机值且队列清空", remote2.address === "本机新地址" && s.queue.length === 0);
}

// 2b. 采用远端：拉取远端值，不产生补传
{
  const s = await freshStore();
  s.updateHousehold("h1", { address: "本机地址B" });
  await s.simulateSync();
  const conflict = s.conflicts.find((c: any) => c.field === "address");
  s.resolveConflict(conflict.id, "采用远端");
  const h1 = s.households.find((h: any) => h.id === "h1");
  KEYS.check("采用远端后本地更新为远端值", h1.address === "河湾路18号2栋2单元");
  KEYS.check("采用远端不产生待上传条目", s.queue.length === 0);
}

// 3. 需求等级改动 → 未完成任务优先级重算（已完成任务不动）
{
  const s = await freshStore();
  s.addTask({ householdId: "h1", title: "现场核查", assignee: "救援一组", priority: "紧急", due: "2026-10-01 12:00" });
  s.addTask({ householdId: "h1", title: "物资配送", assignee: "后勤组", priority: "紧急", due: "2026-10-01 12:00" });
  const finished = s.tasks.find((t: any) => t.title === "物资配送");
  s.advanceTask(finished.id);
  s.advanceTask(finished.id); // → 已完成
  s.updateHousehold("h1", { needLevel: "一般" });
  const open = s.tasks.find((t: any) => t.title === "现场核查");
  KEYS.check("未完成任务优先级随等级重算", open.priority === "一般");
  KEYS.check("已完成任务优先级不被改动", finished.priority === "紧急");
  KEYS.check("重算动作单独排队补传", s.queue.some((i: any) => i.action === "优先级重算"));
}

// 4a. 合并重复家庭：任务改指保留记录 + 未完成任务在则不能标已完成
{
  const s = await freshStore();
  s.addTask({ householdId: "h3", title: "重复户任务", assignee: "救援二组", priority: "紧急", due: "2026-10-01 12:00" });
  const dupTask = s.tasks.find((t: any) => t.title === "重复户任务");
  s.mergeDuplicate("h3", "h1");
  KEYS.check("源记录被删除", !s.households.some((h: any) => h.id === "h3"));
  KEYS.check("关联任务改指保留记录", dupTask.householdId === "h1");
  const h1 = s.households.find((h: any) => h.id === "h1");
  KEYS.check("有未完成任务时家庭不标为已完成", h1.status !== "已完成");
  // 远端同样完成迁移
  await s.simulateSync();
  const remote = s.remoteHouseholds.find((h: any) => h.id === "h1");
  const remoteTask = s.remoteTasks.find((t: any) => t.title === "重复户任务");
  KEYS.check("同步后远端删除源记录", !s.remoteHouseholds.some((h: any) => h.id === "h3"));
  KEYS.check("同步后远端任务改指", remoteTask && remoteTask.householdId === "h1");
  KEYS.check("合并后队列清空", s.queue.length === 0);
  KEYS.check("远端有未完成任务时状态不是已完成", remote.status !== "已完成");
}

// 4c. 全部任务完成才能标已完成；再有新任务会复活
{
  const s = await freshStore();
  // h2 有进行中的 k1
  const h2 = s.households.find((h: any) => h.id === "h2");
  s.advanceTask("k1"); // → 已完成，h2 自动标已完成
  const h2done = s.households.find((h: any) => h.id === "h2");
  KEYS.check("唯一未完成任务完成后家庭标已完成", h2done.status === "已完成");
  s.addTask({ householdId: "h2", title: "回访", assignee: "救援一组", priority: "一般", due: "2026-10-02 09:00" });
  KEYS.check("新增未完成任务后家庭不再是已完成", s.households.find((h: any) => h.id === "h2").status !== "已完成");
}

// 5. 同步失败：队列保留，可重试，且不产生冲突
{
  const s = await freshStore();
  s.updateHousehold("h1", { address: "失败重试地址" });
  const before = s.queue.length;
  await s.simulateSync(true);
  KEYS.check("失败后队列条目保留", s.queue.length === before);
  KEYS.check("失败条目标记失败并累计重试次数", s.queue[0].status === "上传失败" && s.queue[0].retries === 1);
  KEYS.check("失败时不产生任何冲突", s.conflicts.length === 0);
  await s.simulateSync();
  KEYS.check("重试成功后冲突正常生成且无重复", s.conflicts.filter((c: any) => c.status === "待处理").length === 1);
}

// 6. 持久化：刷新页面后字段队列仍在
{
  const s = await freshStore();
  s.updateHousehold("h1", { note: "断电也要记得我" });
  await new Promise((r) => setTimeout(r, 50));
  const raw = JSON.parse(localStorage.getItem(KEY)!);
  KEYS.check("队列持久化到 localStorage", raw.queue[0].fields[0].newValue === "断电也要记得我");
}

console.log(`\n${KEYS.passed} checks passed`);
