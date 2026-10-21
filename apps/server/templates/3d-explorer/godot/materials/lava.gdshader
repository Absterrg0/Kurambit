shader_type spatial;
render_mode unshaded, cull_back;

// The hazard pool. It is the one saturated warning colour in the level, so it stays
// self-lit (unshaded) and animated: a slow wave on the surface plus drifting hot veins.
// The value and hue do the telegraphing; the wave just keeps it from reading as a flat
// orange rectangle, which is how a blockout hazard gives itself away.
uniform vec3 crust_color : source_color = vec3(0.28, 0.05, 0.03);
uniform vec3 hot_color : source_color = vec3(0.95, 0.28, 0.06);
uniform vec3 core_color : source_color = vec3(1.0, 0.78, 0.28);
uniform float wave_height = 0.035;
uniform float wave_speed = 0.8;
uniform float vein_scale = 0.9;

varying vec3 world_position;

float hash(vec2 p) {
	p = fract(p * vec2(127.1, 311.7));
	p += dot(p, p + 34.23);
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

float fbm(vec2 p) {
	float total = 0.0;
	float amplitude = 0.55;
	for (int octave = 0; octave < 3; octave++) {
		total += value_noise(p) * amplitude;
		p = p * 2.07 + vec2(13.1, 7.7);
		amplitude *= 0.5;
	}
	return total;
}

void vertex() {
	world_position = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	// A gentle swell, so the lit surface has a horizon of its own.
	VERTEX.y += sin(VERTEX.x * 2.1 + TIME * wave_speed) * wave_height
		+ cos(VERTEX.z * 1.7 - TIME * wave_speed * 0.8) * wave_height;
}

void fragment() {
	float time = TIME * 0.22;
	vec2 flow = world_position.xz * vein_scale;
	float veins = fbm(flow + vec2(time, time * 0.6));
	float crust = smoothstep(0.34, 0.58, veins);
	vec3 color = mix(hot_color, core_color, crust * 0.75);
	color = mix(crust_color, color, smoothstep(0.18, 0.42, veins));
	// A brighter halo where the surface faces the camera sells the liquid.
	float facing = clamp(abs(normalize((INV_VIEW_MATRIX * vec4(NORMAL, 0.0)).xyz).y), 0.0, 1.0);
	color = mix(color, core_color, (1.0 - facing) * 0.25);
	ALBEDO = color;
	EMISSION = color * (1.1 + crust * 0.9);
}
