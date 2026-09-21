import { createRouter, createWebHistory } from 'vue-router';
import OverviewPage from '../pages/OverviewPage.vue';
import MobilePage from '../pages/MobilePage.vue';
import ClientAuthorizePage from '../pages/ClientAuthorizePage.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: OverviewPage },
    { path: '/mobile', component: MobilePage, meta: { mobile: true } },
    { path: '/client/authorize', component: ClientAuthorizePage },
  ],
});
