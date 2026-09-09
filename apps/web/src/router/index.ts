import { createRouter, createWebHistory } from 'vue-router';
import OverviewPage from '../pages/OverviewPage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/', component: OverviewPage }],
});

