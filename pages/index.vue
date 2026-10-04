<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type Household, type NeedLevel } from "~/stores/assessment";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const syncMessage = ref("");
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
const membersText = computed({
  get: () => String(members.value ?? ""),
  set: (v) => { (members as { value: unknown }).value = v; }
});
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);
const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");
const editForm = reactive({ head: "", community: "", address: "", members: "1", needLevel: "一般" as NeedLevel, needs: "", vulnerable: "", note: "" });

watch(selected, (household) => {
  if (!household) return;
  editForm.head = household.head;
  editForm.community = household.community;
  editForm.address = household.address;
  editForm.members = String(household.members);
  editForm.needLevel = household.needLevel;
  editForm.needs = household.needs.join("，");
  editForm.vulnerable = household.vulnerable.join("，");
  editForm.note = household.note;
}, { immediate: true });

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function saveEdit() {
  const household = selected.value;
  if (!household) return;
  const patch: Partial<Household> = {};
  if (editForm.head !== household.head) patch.head = editForm.head;
  if (editForm.community !== household.community) patch.community = editForm.community;
  if (editForm.address !== household.address) patch.address = editForm.address;
  if (Number(editForm.members) !== household.members) patch.members = Number(editForm.members);
  if (editForm.needLevel !== household.needLevel) patch.needLevel = editForm.needLevel;
  const nextNeeds = editForm.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  if (JSON.stringify(nextNeeds) !== JSON.stringify(household.needs)) patch.needs = nextNeeds;
  const nextVulnerable = editForm.vulnerable.split(/[，,]/).map((item) => item.trim()).filter(Boolean);
  if (JSON.stringify(nextVulnerable) !== JSON.stringify(household.vulnerable)) patch.vulnerable = nextVulnerable;
  if (editForm.note !== household.note) patch.note = editForm.note;
  if (!Object.keys(patch).length) { syncMessage.value = "没有字段被修改。"; return; }
  store.updateHousehold(household.id, patch);
  syncMessage.value = `已离线保存 ${Object.keys(patch).length} 个字段改动（含改前值与基准版本），排队待同步。`;
}
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join("、");
  if (value === null || value === undefined) return "—";
  return String(value);
}
async function sync() {
  if (!store.online) { syncMessage.value = "仍在弱网状态，队列保留在设备中。"; return; }
  if (!store.queue.length) { syncMessage.value = "没有待同步的变更。"; return; }
  syncMessage.value = "正在人工合并离线变更…";
  const result = await store.simulateSync();
  if (!result.ok) {
    syncMessage.value = `同步失败（网络中断），${store.queue.length} 项变更保留在队列中，请重试。`;
  } else if (result.conflicts) {
    syncMessage.value = `同步完成：${result.processed} 项已按字段自动合并，发现 ${result.conflicts} 个同字段冲突待人工处理。`;
  } else {
    syncMessage.value = `同步完成：${result.processed} 项变更已按字段自动合并，无冲突。`;
  }
}
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>记录可离线保存，恢复连接后必须人工确认字段冲突。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录与任务仍可操作，所有变更会写入IndexedDB兼容的本地缓存与待同步队列。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectedId = item.id"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
        <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput v-model:value="membersText" placeholder="1-30" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync">尝试同步</NButton></div></form></NCard>
      </div>
      <NCard v-if="panel === '需求记录'" title="修改选中家庭（离线排队）"><p>当前家庭：<b>{{ selected?.head }}</b> · 改动按字段记录改前值与基准版本，回网后按字段合并，不整条覆盖。</p><form class="field-grid" @submit.prevent="saveEdit"><label class="field"><span>户主姓名</span><NInput v-model:value="editForm.head" /></label><label class="field"><span>社区</span><NInput v-model:value="editForm.community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="editForm.address" /></label><label class="field"><span>家庭人数</span><NInput v-model:value="editForm.members" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="editForm.needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="editForm.needs" /></label><label class="field wide"><span>特殊照护（逗号分隔）</span><NInput v-model:value="editForm.vulnerable" /></label><label class="field wide"><span>现场说明</span><NInput v-model:value="editForm.note" type="textarea" /></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存修改并排队</NButton></div></form></NCard>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条并保留需求并集</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ task.due }}</small></div><NTag>{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b></p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作"><p>{{ syncMessage || '恢复连接后按字段合并：不同字段自动合并，同字段冲突留两版待处理；同步失败队列保留可重试。' }}</p><div v-for="item in store.queue" :key="item.id" class="queue-row"><NTag>{{ item.action }}</NTag><div class="queue-body"><span>{{ item.entity }} · {{ item.detail }}</span><small v-if="item.baseVersion">基准版本 v{{ item.baseVersion }}</small><div v-for="change in item.changes" :key="change.field" class="queue-change"><small>{{ change.field }}：{{ formatValue(change.before) }} → {{ formatValue(change.after) }}</small></div></div><small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }}</small></div><p v-if="!store.queue.length" class="empty">待同步队列为空。</p><NButton type="primary" :loading="store.syncing" @click="sync">人工确认并同步</NButton><small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small></NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突"><div v-for="item in store.conflicts" :key="item.id" class="conflict"><b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ item.field }}</b><div class="conflict-values"><div><small>本机记录</small><span>{{ formatValue(item.localValue) }}</span></div><div><small>远端记录</small><span>{{ formatValue(item.remoteValue) }}</span></div></div><div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端</NButton><NTag>{{ item.status }}</NTag></div></div><p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先点击“人工确认并同步”模拟多人合并。</p></NCard>
    </main>
  </div>
</template>
