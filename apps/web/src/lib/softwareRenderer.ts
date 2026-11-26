let softwareProbe: boolean | undefined;
/**
 * Whether this renderer draws on the CPU (SwiftShader, llvmpipe): no usable GPU. A game playing
 * there takes most of the machine's cores, even on its title screen, and so does any continuous
 * animation in the app itself: a 15 px spinner costs several cores. Asked once.
 */
export const rendererIsSoftware = (): boolean => {
  if (softwareProbe === undefined) {
    const gl = document.createElement("canvas").getContext("webgl");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const renderer =
      gl == null || info == null ? "" : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    // The probe's context is let go at once: a page holds only a few live ones.
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    softwareProbe = /swiftshader|llvmpipe|softpipe|software/i.test(renderer);
  }
  return softwareProbe;
};
