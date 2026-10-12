<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, RouterView, useRoute } from 'vue-router';
const route = useRoute();
const workspacePath = computed(() => route.query.from === 'mobile' ? '/mobile' : '/');
</script>

<template>
  <div class="shell">
    <header v-if="!route.meta.mobile" class="app-header">
      <RouterLink class="app-brand" :to="workspacePath" aria-label="TermRelay 工作台"><span class="app-brand-mark" aria-hidden="true">&gt;_</span><strong>TermRelay</strong></RouterLink>
      <nav class="app-nav" aria-label="主要导航">
        <RouterLink :to="workspacePath">工作台</RouterLink>
        <RouterLink :to="{ path: '/settings', query: route.query.from === 'mobile' ? { from: 'mobile' } : {} }">配置</RouterLink>
      </nav>
      <div id="app-header-actions" class="workspace-actions" />
    </header>
    <RouterView />
  </div>
</template>
