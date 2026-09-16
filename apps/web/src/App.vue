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
    </header>
    <RouterView />
  </div>
</template>
