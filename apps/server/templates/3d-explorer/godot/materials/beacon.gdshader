shader_type spatial;
render_mode unshaded, blend_mix, cull_disabled, depth_draw_never;

// The goal's landmark shaft. Additive and soft-edged, so it reads as light in the air
// rather than as a cone mesh: the fade at both ends removes the hard cylinder caps that
// make a blockout beacon look like a roadside cone. A fresnel-style term keeps the
// centre brightest and dissolves the silhouette.
uniform vec3 beam_color : source_color = vec3(0.35, 0.9, 0.8);
uniform float intensity = 0.4;
uniform float fade_top = 0.65;
uniform float fade_bottom = 0.08;

void fragment() {
	float vertical = smoothstep(0.0, fade_bottom, UV.y) * (1.0 - smoothstep(1.0 - fade_top, 1.0, UV.y));
	float facing = abs(dot(normalize(NORMAL), normalize(VIEW)));
	float body = 0.3 + 0.7 * pow(facing, 0.7);
	ALBEDO = beam_color;
	ALPHA = clamp(intensity * vertical * body, 0.0, 1.0);
}
