import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/audio-graph" },
  {
    path: "/audio-graph",
    name: "audio-graph",
    component: () => import("./views/AudioGraphView.vue"),
    meta: { label: "Audio graph", icon: "graph" },
  },
  {
    path: "/live-state",
    name: "live-state",
    component: () => import("./views/LiveStateView.vue"),
    meta: { label: "Live state", icon: "wave" },
  },
  {
    path: "/signals",
    name: "signals",
    component: () => import("./views/SignalsView.vue"),
    meta: { label: "Signals & performance", icon: "gauge" },
  },
  {
    path: "/midi",
    name: "midi",
    component: () => import("./views/MidiView.vue"),
    meta: { label: "MIDI", icon: "piano" },
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
