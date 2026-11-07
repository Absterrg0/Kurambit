// gltfpack ships JavaScript without types; this is its library.js API as its own docs give it.
declare module "gltfpack" {
  export function pack(
    args: ReadonlyArray<string>,
    iface: {
      readonly read: (path: string) => Uint8Array;
      readonly write: (path: string, data: Uint8Array) => void;
    },
  ): Promise<string>;
}
