shader_type spatial;
render_mode unshaded, cull_front, depth_draw_opaque;

// Inverted-hull silhouette. The template's player is a bright capsule, which still
// loses its edge against pale sand or a lit path; a 2% dark shell around the body gives
// every ground colour something to contrast with and costs one extra draw.
uniform vec3 outline_color : source_color = vec3(0.05, 0.055, 0.08);

void vertex() {
	VERTEX += NORMAL * 0.022;
}

void fragment() {
	ALBEDO = outline_color;
}
