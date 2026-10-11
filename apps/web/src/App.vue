<script setup lang="ts">
import { RouterView } from 'vue-router';
import { useRoute } from 'vue-router';
const route = useRoute();
</script>

<template>
  <div class="shell">
    <header v-if="!route.meta.mobile" class="app-header">
      <strong>TermRelay</strong>
      <span>Your terminals, within reach.</span>
      <RouterLink to="/">会话</RouterLink>
      <RouterLink to="/settings">配置</RouterLink>
    </header>
    <RouterView />
  </div>
</template>
