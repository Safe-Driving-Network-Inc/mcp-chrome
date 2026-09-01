<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">Element Selector</label>
      <input
        class="form-input"
        v-model="(node as any).config.selector"
        placeholder="CSS selector"
      />
    </div>
    <div class="form-group">
      <label class="form-label">List Variable Name</label>
      <input
        class="form-input"
        v-model="(node as any).config.saveAs"
        placeholder="Default: elements"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Loop Item Variable Name</label>
      <input
        class="form-input"
        v-model="(node as any).config.itemVar"
        placeholder="Default: item"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Subflow ID</label>
      <input
        class="form-input"
        v-model="(node as any).config.subflowId"
        placeholder="Select or create a subflow"
      />
      <button class="btn-sm" style="margin-top: 8px" @click="onCreateSubflow">New Subflow</button>
    </div>
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';

const props = defineProps<{ node: NodeBase }>();
const emit = defineEmits<{ (e: 'create-subflow', id: string): void }>();

function onCreateSubflow() {
  const id = prompt('Enter new subflow ID');
  if (!id) return;
  emit('create-subflow', id);
  const n = props.node as any;
  if (n && n.config) n.config.subflowId = id;
}
</script>

<style scoped></style>
