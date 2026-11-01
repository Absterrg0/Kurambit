import { describe, expect, it } from "vite-plus/test";

import { useGameDialogStore } from "./gameDialogStore";

describe("gameDialogStore", () => {
  it("opens and closes the create and open dialogs", () => {
    const store = useGameDialogStore.getState();

    store.show("create");
    expect(useGameDialogStore.getState()).toMatchObject({ dialog: "create" });

    store.show("open");
    expect(useGameDialogStore.getState()).toMatchObject({ dialog: "open" });

    store.show(null);
    expect(useGameDialogStore.getState()).toMatchObject({ dialog: null });
  });
});
