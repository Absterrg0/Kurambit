/** The warm halftone glow behind an empty state, in two dot grids. Its parent must be positioned. */
export function Atmosphere() {
  return (
    <>
      <div aria-hidden="true" className="atmosphere" />
      <div aria-hidden="true" className="atmosphere-core" />
    </>
  );
}
