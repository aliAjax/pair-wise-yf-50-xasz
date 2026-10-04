<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NSelect, NStatistic, NSwitch, NTag } from "naive-ui";
import { useOnline } from "@vueuse/core";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useAssessmentStore, type Household, type NeedLevel } from "~/stores/assessment";
import { displayValue, fieldLabel } from "~/utils/merge";
import { probeCache } from "~/utils/api";

const store = useAssessmentStore();
const browserOnline = useOnline();
const panel = ref("需求记录");
const selectedId = ref(store.households[0]?.id ?? "");
const cacheProbe = ref<{ cachedAt: string; source: string } | null>(null);
const schema = toTypedSchema(z.object({ head: z.string().min(2, "请输入户主姓名"), community: z.string().min(2), address: z.string().min(4), members: z.coerce.number().min(1).max(30), needLevel: z.enum(["紧急", "高", "一般"]), needs: z.string().min(2), note: z.string().min(2) }));
const { defineField, errors, handleSubmit, resetForm } = useForm({ validationSchema: schema, initialValues: { head: "", community: "河湾社区", address: "", members: 1, needLevel: "一般" as NeedLevel, needs: "", note: "" } });
const [head] = defineField("head");
const [community] = defineField("community");
const [address] = defineField("address");
const [members] = defineField("members");
function setMembers(v: string) {
  members.value = (v === "" ? undefined : Number(v)) as never;
}
const [needLevel] = defineField("needLevel");
const [needs] = defineField("needs");
const [note] = defineField("note");
const selected = computed(() => store.households.find((item) => item.id === selectedId.value) ?? store.households[0]);

// 字段级快速编辑：每次保存记录字段、改前值与基准版本
const editAddress = ref("");
const editNeedLevel = ref<NeedLevel>("一般");
const editNote = ref("");
const editTouched = ref(false);

function hydrateEdit() {
  if (!selected.value) return;
  editAddress.value = selected.value.address;
  editNeedLevel.value = selected.value.needLevel;
  editNote.value = selected.value.note;
  editTouched.value = false;
}
function saveEdit() {
  if (!selected.value) return;
  const patch: Partial<Household> = {};
  if (editAddress.value !== selected.value.address) patch.address = editAddress.value;
  if (editNeedLevel.value !== selected.value.needLevel) patch.needLevel = editNeedLevel.value;
  if (editNote.value !== selected.value.note) patch.note = editNote.value;
  if (!Object.keys(patch).length) return;
  store.updateHousehold(selected.value.id, patch);
  editTouched.value = true;
  setTimeout(hydrateEdit, 0);
}
function selectHousehold(id: string) {
  selectedId.value = id;
  hydrateEdit();
}

const taskAssignee = ref("救援一组");
const taskTitle = ref("现场复核");

onMounted(async () => {
  cacheProbe.value = await probeCache();
  store.online = browserOnline.value;
  hydrateEdit();
});
const submit = handleSubmit((values) => {
  store.addHousehold({ head: values.head, community: values.community, address: values.address, members: Number(values.members), vulnerable: [], needLevel: values.needLevel as NeedLevel, needs: values.needs.split(/[，,]/).map((item) => item.trim()).filter(Boolean), note: values.note });
  resetForm();
});
function assignTask() {
  if (!selected.value) return;
  store.addTask({ householdId: selected.value.id, title: taskTitle.value, assignee: taskAssignee.value, priority: selected.value.needLevel, due: "2026-09-30 18:00" });
}
async function sync(forceFail = false) {
  await store.simulateSync(forceFail);
}
const queueTagType: Record<string, "default" | "error" | "warning" | "success" | "info"> = {
  待上传: "info",
  上传失败: "error",
  待处理冲突: "warning"
};
</script>

<template>
  <div class="shell">
    <aside class="side"><div class="brand"><b>FIELD OPS</b><span>灾后评估</span></div><nav><button v-for="item in ['需求记录', '重复合并', '任务分派', '同步队列', '冲突处理']" :key="item" :class="{ active: panel === item }" @click="panel = item">{{ item }} <span v-if="item === '同步队列' && store.queue.length">({{ store.queue.length }})</span><span v-else-if="item === '冲突处理' && store.pendingConflicts.length" class="nav-badge">({{ store.pendingConflicts.length }})</span></button></nav><div class="network"><small>设备与网络</small><b>{{ browserOnline && store.online ? '在线' : '弱网 / 离线' }}</b><NSwitch v-model:value="store.online" /><small>最近同步 {{ new Date(store.lastSyncedAt).toLocaleTimeString('zh-CN') }}</small></div></aside>
    <main>
      <header><div><small>评估批次 2026-09-29 · 河湾片区</small><h1>灾后需求评估与任务分派</h1><p>记录可离线保存，恢复连接后按字段三路合并，冲突不静默覆盖。</p></div><div class="status-chip"><NProgress type="circle" :percentage="100 - store.queue.length * 8" :stroke-width="8" :width="42" /><span>{{ store.queue.length ? `${store.queue.length} 项待同步` : '数据已同步' }}</span></div></header>
      <section class="metrics"><NCard><NStatistic label="评估家庭" :value="store.metrics.households" /></NCard><NCard><NStatistic label="紧急需求" :value="store.metrics.urgent" /></NCard><NCard><NStatistic label="未完成任务" :value="store.metrics.openTasks" /></NCard><NCard><NStatistic label="本地队列" :value="store.metrics.queued" /></NCard></section>
      <NAlert v-if="!browserOnline || !store.online" type="warning" show-icon>当前网络不可用。新增记录、字段修改与任务流转仍可操作，每条改动按字段写入本地待同步队列，回网后自动按字段合并。</NAlert>
      <div v-if="panel === '需求记录'" class="page-grid">
        <div class="side-stack">
          <NCard title="家庭走访记录" :bordered="false"><div class="households"><article v-for="item in store.households" :key="item.id" class="household" :class="{ selected: selectedId === item.id }" @click="selectHousehold(item.id)"><div><b>{{ item.head }} · {{ item.members }}人</b><small>{{ item.community }} / {{ item.address }}</small><p>{{ item.needs.join('、') }} · {{ item.note }}</p></div><div><NTag :type="item.needLevel === '紧急' ? 'error' : item.needLevel === '高' ? 'warning' : 'success'">{{ item.needLevel }}</NTag><small>{{ item.status }} · v{{ item.version }}</small></div></article></div></NCard>
          <NCard title="新增需求记录"><form class="field-grid" @submit.prevent="submit"><label class="field"><span>户主姓名</span><NInput v-model:value="head" /><small>{{ errors.head }}</small></label><label class="field"><span>社区</span><NInput v-model:value="community" /></label><label class="field wide"><span>地址描述</span><NInput v-model:value="address" placeholder="不使用地图坐标时可描述楼栋与单元" /><small>{{ errors.address }}</small></label><label class="field"><span>家庭人数</span><NInput :value="String(members ?? '')" :input-props="{ type: 'number', min: 1, max: 30 }" @update:value="setMembers" /></label><label class="field"><span>需求等级</span><NSelect v-model:value="needLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label><label class="field wide"><span>主要需求（逗号分隔）</span><NInput v-model:value="needs" placeholder="临时安置，饮用水" /><small>{{ errors.needs }}</small></label><label class="field wide"><span>现场说明</span><NInput v-model:value="note" type="textarea" /><small>{{ errors.note }}</small></label><div class="actions wide"><NButton attr-type="submit" type="primary">保存本地记录</NButton><NButton @click="sync(false)">尝试同步</NButton></div></form></NCard>
        </div>
        <NCard v-if="selected" :title="`字段编辑 · ${selected.head}（v${selected.version}）`" :bordered="false">
          <p class="hint">修改会逐字段记录“改前值 + 基准版本”。只改地址会与远端同事的地址改动冲突；只改现场说明则属于不同字段，自动合并。</p>
          <div class="field-grid single">
            <label class="field wide"><span>地址</span><NInput v-model:value="editAddress" /></label>
            <label class="field wide"><span>需求等级（保存后自动重算未完成任务优先级）</span><NSelect v-model:value="editNeedLevel" :options="[{value:'紧急',label:'紧急'},{value:'高',label:'高'},{value:'一般',label:'一般'}]" /></label>
            <label class="field wide"><span>现场说明</span><NInput v-model:value="editNote" type="textarea" /></label>
          </div>
          <div class="actions"><NButton type="primary" @click="saveEdit">保存字段改动并入队</NButton><NButton @click="hydrateEdit">重置</NButton></div>
          <NTag v-if="editTouched" type="success" class="saved-tag">已按字段入队，可到“同步队列”查看改前值/基准版本</NTag>
        </NCard>
      </div>
      <NCard v-if="panel === '重复合并'" title="疑似重复记录"><div v-for="group in store.duplicates" :key="group.map((item) => item.id).join('-')" class="duplicate"><b>{{ group[0].head }} · {{ group[0].community }}</b><p>{{ group.map((item) => `${item.address} / ${item.note}`).join('；') }}</p><p class="hint">关联任务将改指保留记录；若仍有未完成任务，保留记录不会被标成已完成。</p><NButton type="primary" size="small" @click="store.mergeDuplicate(group[1].id, group[0].id)">合并为一条并保留需求并集</NButton></div><p v-if="!store.duplicates.length" class="empty">没有检测到疑似重复记录。</p></NCard>
      <div v-if="panel === '任务分派'" class="page-grid"><NCard title="任务列表"><div v-for="task in store.tasks" :key="task.id" class="task-row"><div><b :class="{ complete: task.status === '已完成' }">{{ task.title }}</b><small>{{ store.households.find((item) => item.id === task.householdId)?.head }} · {{ task.due }}</small></div><NTag :type="task.priority === '紧急' ? 'error' : task.priority === '高' ? 'warning' : 'success'">{{ task.priority }}</NTag><span>{{ task.assignee }} · {{ task.status }}</span><NButton size="small" :disabled="task.status === '已完成'" @click="store.advanceTask(task.id)">推进状态</NButton></div><p v-if="!store.tasks.length" class="empty">暂无任务。</p></NCard><NCard title="分派新任务"><p>当前家庭：<b>{{ selected?.head }}</b>（{{ selected?.needLevel }}，优先级随家庭等级自动带出）</p><label class="field"><span>任务内容</span><NInput v-model:value="taskTitle" /></label><label class="field"><span>执行人/小组</span><NInput v-model:value="taskAssignee" /></label><NButton type="primary" block :disabled="!selected" @click="assignTask">加入任务并本地排队</NButton><p class="hint">若该家庭还有未完成任务，状态不会落到“已完成”。</p></NCard></div>
      <NCard v-if="panel === '同步队列'" title="待同步操作（字段级）">
        <div class="actions queue-actions">
          <NButton type="primary" :loading="store.syncing" @click="sync(false)">人工确认并同步</NButton>
          <NButton :loading="store.syncing" @click="sync(true)">模拟本次网络故障</NButton>
          <NSwitch v-model:value="store.online" size="small" /> <span class="hint">设备在线开关</span>
        </div>
        <p :class="['sync-msg', { fail: store.metrics.failed || store.syncMessage.includes('失败') }]">{{ store.syncMessage || '恢复连接后按顺序提交：不同字段自动合并，同字段留两版待处理；同步只移除已成功条目，绝不整队清空。' }}</p>
        <div v-for="item in store.queue" :key="item.id" class="queue-row detailed">
          <NTag :type="queueTagType[item.status] ?? 'default'">{{ item.status }}</NTag>
          <div class="queue-body">
            <b>{{ item.action }} · {{ item.entity }} · {{ item.detail }}</b>
            <small>{{ new Date(item.time).toLocaleTimeString('zh-CN') }} · 基准版本 v{{ item.baseVersion }}<span v-if="item.retries"> · 已重试 {{ item.retries }} 次</span><span v-if="item.forceOverride"> · 冲突后采用本机</span></small>
            <div v-if="item.fields.length" class="field-diff">
              <span v-for="field in item.fields" :key="field.field" class="diff-chip"><em>{{ fieldLabel(field.field) }}</em>：{{ displayValue(field.oldValue) }} → <b>{{ displayValue(field.newValue) }}</b></span>
            </div>
            <small v-else class="hint">新建/分派类条目（携带首版快照）</small>
          </div>
        </div>
        <p v-if="!store.queue.length" class="empty">待同步队列为空。</p>
        <div v-if="selected" class="remote-baseline">
          <small>模拟服务器上该家庭的当前基线（同事可能已改）：</small>
          <template v-for="remote in store.remoteHouseholds.filter((item) => item.id === selected.id)" :key="remote.id">
            <div class="diff-chip"><em>地址</em>：{{ remote.address }}</div>
            <div class="diff-chip"><em>特殊照护</em>：{{ remote.vulnerable.join('、') || '（空）' }}</div>
            <div class="diff-chip"><em>版本</em>：v{{ remote.version }}</div>
          </template>
          <small v-if="!store.remoteHouseholds.some((item) => item.id === selected.id)" class="hint">服务器上还没有这条记录。</small>
        </div>
        <small v-if="cacheProbe"> 数据缓存时间：{{ new Date(cacheProbe.cachedAt).toLocaleTimeString('zh-CN') }}</small>
      </NCard>
      <NCard v-if="panel === '冲突处理'" title="字段级冲突（保留两版）">
        <p class="hint">同字段双方都改才进入这里；重复点同步不会新增相同冲突。解决后采用本机的版本会补传回服务器。</p>
        <div v-for="item in store.conflicts" :key="item.id" :class="['conflict', { resolved: item.status !== '待处理' }]">
          <b>{{ store.households.find((household) => household.id === item.householdId)?.head }} · {{ fieldLabel(item.field) }}</b>
          <small class="conflict-meta">本机 v{{ item.localVersion }} ↔ 远端 v{{ item.remoteVersion }}</small>
          <div class="conflict-values three"><div><small>基准（改前值）</small><span>{{ displayValue(item.baseValue) }}</span></div><div><small>本机改后</small><span>{{ displayValue(item.localValue) }}</span></div><div><small>远端同事</small><span>{{ displayValue(item.remoteValue) }}</span></div></div>
          <div class="actions"><NButton size="small" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用本地')">采用本机并补传</NButton><NButton size="small" type="primary" :disabled="item.status !== '待处理'" @click="store.resolveConflict(item.id, '采用远端')">采用远端并拉取</NButton><NTag :type="item.status === '待处理' ? 'warning' : 'success'">{{ item.status }}</NTag></div>
        </div>
        <p v-if="!store.conflicts.length" class="empty">暂无字段冲突。可先离线修改“王建国”的地址或现场说明，再点击“人工确认并同步”模拟多人合并。</p>
      </NCard>
    </main>
  </div>
</template>
