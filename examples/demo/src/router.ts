import { createRouter, createWebHashHistory } from "vue-router";

import ExampleView from "./views/ExampleView.vue";
import HomeView from "./views/HomeView.vue";

// Hash history: the demo is a static SPA, so no server-side rewrite is needed.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: "/", name: "home", component: HomeView },
    { path: "/e/:slug", name: "example", component: ExampleView, props: true },
  ],
});
