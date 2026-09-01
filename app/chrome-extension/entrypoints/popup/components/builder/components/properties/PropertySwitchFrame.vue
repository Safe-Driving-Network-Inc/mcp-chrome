<template>
  <div class="form-section">
    <div class="form-group">
      <label class="form-label">Match by URL Contains (preferred)</label>
      <input
        class="form-input"
        v-model="(node as any).config.frame.urlContains"
        placeholder="Substring the frame URL contains"
      />
    </div>
    <div class="form-group">
      <label class="form-label">Match by Index (0-based, child frames only)</label>
      <input
        class="form-input"
        v-model="(node as any).config.frame.index"
        placeholder="Index number"
      />
    </div>
    <div class="text-xs text-slate-500" style="padding: 0 20px"
      >Works for same-origin / injectable frames; leave empty to return to the top-level page</div
    >
  </div>
</template>

<script lang="ts" setup>
/* eslint-disable vue/no-mutating-props */
import type { NodeBase } from '@/entrypoints/background/record-replay/types';
defineProps<{ node: NodeBase }>();
</script>

<style scoped></style>
