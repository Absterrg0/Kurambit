import { describe, expect, it } from "vite-plus/test";

import { useGameDialogStore } from "./gameDialogStore";

describe("gameDialogStore", () => {
  it("scopes a starter template to the create dialog that picked it", () => {
    const store = useGameDialogStore.getState();

    store.show("create", "2d-screen");
    expect(useGameDialogStore.getState()).toMatchObject({
      dialog: "create",
      template: "2d-screen",
    });

    // Opening a folder, or the plain New game entry point, must not inherit it.
    store.show("open");
    expect(useGameDialogStore.getState()).toMatchObject({ dialog: "open", template: null });
    store.show("create");
    expect(useGameDialogStore.getState()).toMatchObject({ dialog: "create", template: null });

    store.show("create", "2d-platformer");
    store.show(null);
    expect(useGameDialogStore.getState()).toMatchObject({ dialog: null, template: null });
  });
});
