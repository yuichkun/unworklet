import { expect, test } from "vite-plus/test";
import { createApp, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import App from "./App.vue";

test("navigation uses route labels with path fallback and follows active nested paths", async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", redirect: "/graph" },
      {
        path: "/graph",
        meta: { label: "Graph" },
        component: { render: () => h("p", "Graph view") },
      },
      { path: "/state", component: { render: () => h("p", "State view") } },
    ],
  });
  const root = document.createElement("div");
  document.body.append(root);
  const app = createApp(App);
  app.use(router);
  app.mount(root);
  try {
    await router.isReady();
    await nextTick();
    expect([...root.querySelectorAll(".nav-link")].map((el) => el.textContent)).toEqual([
      "Graph",
      "/state",
    ]);
    expect(root.querySelector(".nav-link.active")!.textContent).toBe("Graph");
    root.querySelectorAll<HTMLAnchorElement>(".nav-link")[1]!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(router.currentRoute.value.path).toBe("/state");
    expect(root.querySelector(".nav-link.active")!.textContent).toBe("/state");
  } finally {
    app.unmount();
    root.remove();
  }
});
