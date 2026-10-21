shader_type spatial;
render_mode diffuse_burley, specular_schlick_ggx;

// One shared material shader for the world's stone, soil and wood. It breaks up the
// flat, stretched UVs of box geometry with two octaves of world-space noise (triplanar,
// so a 60 m ground slab and a 1 m block get the same grain density) at feature sizes the
// third-person camera can read as material, and darkens vertical faces so every block has
// a lit top and a shadowed side. Compatibility-safe: it only uses MODEL_MATRIX,
// INV_VIEW_MATRIX and TIME-free procedural noise.
uniform vec3 base_color : source_color = vec3(0.30, 0.36, 0.24);
uniform vec3 accent_color : source_color = vec3(0.42, 0.47, 0.30);
uniform float noise_scale = 0.5;
uniform float accent_strength : hint_range(0.0, 1.0) = 0.3;
uniform float slope_darkening : hint_range(0.0, 1.0) = 0.28;
uniform float detail_strength : hint_range(0.0, 1.0) = 0.14;
uniform float masonry : hint_range(0.0, 1.0) = 0.0;
uniform vec2 masonry_size = vec2(1.6, 0.8);
uniform float roughness_value : hint_range(0.0, 1.0) = 0.92;

varying vec3 world_position;

float hash(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

float value_noise(vec2 p) {
	vec2 cell = floor(p);
	vec2 blend = fract(p);
	blend = blend * blend * (3.0 - 2.0 * blend);
	float a = hash(cell);
	float b = hash(cell + vec2(1.0, 0.0));
	float c = hash(cell + vec2(0.0, 1.0));
	float d = hash(cell + vec2(1.0, 1.0));
	return mix(mix(a, b, blend.x), mix(c, d, blend.x), blend.y);
}

// Staggered courses. Large flat boxes give the eye no scale; a low-contrast joint grid
// turns a wall into masonry and a path into paving without adding a single polygon.
float masonry_pattern(vec2 uv) {
	vec2 row = uv / masonry_size;
	row.x += step(1.0, mod(floor(row.y), 2.0)) * 0.5;
	vec2 position = fract(row);
	float joint = smoothstep(0.0, 0.05, position.x) * smoothstep(0.0, 0.05, 1.0 - position.x)
		* smoothstep(0.0, 0.08, position.y) * smoothstep(0.0, 0.08, 1.0 - position.y);
	return mix(0.76, 1.0, joint);
}

void vertex() {
	world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	// Triplanar pick: the world axes the local surface faces most, so walls get the
	// same grain density as floors instead of stretched blobs.
	vec3 world_normal = normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz);
	vec3 weight = abs(world_normal);
	vec2 uv = world_position.xz;
	if (weight.x > weight.y && weight.x > weight.z) uv = world_position.zy;
	else if (weight.z > weight.y) uv = world_position.xy;
	// Both octaves stay large: a ~4 m patch and a ~2 m grain at the default scale.
	// Finer noise reads as blotchy camo at the 5.6 m third-person camera, not texture.
	float broad = value_noise(uv * noise_scale * 0.5);
	float grain = value_noise(uv * noise_scale + vec2(7.3, 1.9));
	vec3 albedo = mix(base_color, accent_color, smoothstep(0.32, 0.72, broad) * accent_strength);
	// Half of detail_strength either way: one material with slow, quiet variation.
	albedo *= 1.0 + (grain - 0.5) * detail_strength;
	albedo *= mix(1.0, masonry_pattern(uv), masonry);
	float up = clamp(world_normal.y, 0.0, 1.0);
	albedo = mix(albedo * (1.0 - slope_darkening), albedo, up);
	ALBEDO = albedo;
	ROUGHNESS = roughness_value;
	SPECULAR = 0.2;
}
