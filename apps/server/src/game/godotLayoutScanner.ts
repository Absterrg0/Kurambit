/**
 * The Godot checker's bounded layout-visibility probe. It is a GDScript
 * string, not an asset, so the packed server archive carries it without a
 * second asset-copy rule. The checker concatenates it after `extends
 * SceneTree` and calls `gs_layout_scan_entry(entry, root, report, state)`;
 * `report` is the checker's warning channel, taking `(kind, subject, detail,
 * node_path)`. `state` is a Dictionary of counters (`warnings`, `pairs`,
 * `inspected`) the scan reads and mutates.
 *
 * Geometry alone never proves visual occlusion: a sibling may be
 * transparent, so overlaps report as `overlap-risk`, never as definite.
 * Fully clipped controls and viewport escapes are definite geometry
 * (`clip`, `viewport`), but still native headless measurements at the
 * project's logical size, never proof about the exported Web build.
 * Hidden, disabled, rotated/mirrored, and zero-size controls are skipped as
 * unknown rather than claimed covered or broken, as are rotated occluders,
 * occluders under transparent ancestors, and occluders living in another
 * canvas coordinate space.
 */
export const GODOT_LAYOUT_SCANNER = `# Bounded layout-visibility probe for the checker.
const GS_LAYOUT_MAX_WARNINGS := 10
const GS_LAYOUT_MAX_NODES := 600
const GS_LAYOUT_MAX_CONTROLS := 48
const GS_LAYOUT_MAX_PAIRS := 400
const GS_LAYOUT_MAX_OCCLUDER_NODES := 120
const GS_LAYOUT_MAX_DEPTH := 32
const GS_LAYOUT_MIN_VISIBLE_FRAC := 0.95
const GS_LAYOUT_MIN_OVERLAP_FRAC := 0.25
const GS_LAYOUT_MIN_ALPHA := 0.05

func gs_layout_node_path(root_node: Node, node: Node) -> String:
	if node == root_node:
		return '.'
	return str(root_node.get_path_to(node))

func gs_layout_is_actionable(control: Control) -> bool:
	if control is BaseButton:
		var button := control as BaseButton
		if button.disabled:
			return false
		return button.mouse_filter != Control.MOUSE_FILTER_IGNORE
	if control is LineEdit:
		var line := control as LineEdit
		if not line.editable:
			return false
		return line.mouse_filter != Control.MOUSE_FILTER_IGNORE
	if control is TextEdit:
		var area := control as TextEdit
		if not area.editable:
			return false
		return area.mouse_filter != Control.MOUSE_FILTER_IGNORE
	return false

func gs_layout_has_own_complex_transform(node: Node) -> bool:
	var rot = node.get('rotation')
	if (rot is float or rot is int) and abs(float(rot)) > 0.0001:
		return true
	var skew = node.get('skew')
	if (skew is float or skew is int) and abs(float(skew)) > 0.0001:
		return true
	var sc = node.get('scale')
	if sc is Vector2 and ((sc as Vector2).x < 0.0 or (sc as Vector2).y < 0.0):
		return true
	return false

func gs_layout_has_complex_transform(control: Control, root_node: Node) -> bool:
	var current: Node = control
	var depth := 0
	while current != null and depth <= GS_LAYOUT_MAX_DEPTH:
		if gs_layout_has_own_complex_transform(current):
			return true
		if current == root_node:
			break
		current = current.get_parent()
		depth += 1
	return false

# Only modulate is inherited. self_modulate and ColorRect.color affect the
# item's own paint, so applying those to children hides real overlap risks.
func gs_layout_effective_alpha(item: Node) -> float:
	var alpha := 1.0
	var current: Node = item
	var depth := 0
	while current != null and depth <= GS_LAYOUT_MAX_DEPTH:
		if current is CanvasLayer or current is Viewport:
			break
		if current is CanvasItem:
			alpha *= (current as CanvasItem).modulate.a
			if current == item:
				alpha *= (current as CanvasItem).self_modulate.a
				if current is ColorRect:
					alpha *= (current as ColorRect).color.a
			if alpha < GS_LAYOUT_MIN_ALPHA:
				return alpha
		current = current.get_parent()
		depth += 1
	return alpha

func gs_layout_is_occluder(box: Control) -> bool:
	# Only widgets that paint filled rects by default: transparent parents like
	# plain Containers and Labels cannot be proven to occlude from geometry, so
	# they are left out rather than reported as noise.
	return box is ColorRect or box is Panel or box is TextureRect or box is BaseButton or box is LineEdit or box is TextEdit

func gs_layout_canvas_layer_remaps(layer: Node) -> bool:
	var follow = layer.get('follow_viewport_enabled')
	if follow is bool and follow:
		return true
	var offset = layer.get('offset')
	if offset is Vector2 and (offset as Vector2) != Vector2.ZERO:
		return true
	var rot = layer.get('rotation')
	if (rot is float or rot is int) and abs(float(rot)) > 0.0001:
		return true
	var sc = layer.get('scale')
	if sc is Vector2 and (sc as Vector2) != Vector2.ONE:
		return true
	var xform = layer.get('transform')
	if xform is Transform2D and (xform as Transform2D) != Transform2D.IDENTITY:
		return true
	return false

# Nearest canvas-space owner: rects from different CanvasLayers, SubViewports
# or Viewports are not comparable, so an occluder there is skipped as unknown.
func gs_layout_canvas_root(node: Node) -> Node:
	var current: Node = node
	var depth := 0
	while current != null and depth <= GS_LAYOUT_MAX_DEPTH:
		if current is CanvasLayer or current is SubViewport or current is Viewport:
			return current
		current = current.get_parent()
		depth += 1
	return current

# A rotated, skewed or mirrored occluder (or one hung under such an
# ancestor below the shared parent) has an axis-aligned rect the overlap math
# cannot trust, so it is skipped as unknown rather than reported.
func gs_layout_path_complex(node: Node, stop_parent: Node) -> bool:
	var current: Node = node
	var depth := 0
	while current != null and current != stop_parent and depth <= GS_LAYOUT_MAX_DEPTH:
		if gs_layout_has_own_complex_transform(current):
			return true
		current = current.get_parent()
		depth += 1
	return false

func gs_layout_in_scroll(control: Control) -> bool:
	var current := control.get_parent()
	var depth := 0
	while current != null and depth < GS_LAYOUT_MAX_DEPTH:
		if current is Viewport:
			return false
		if current is ScrollContainer:
			return true
		current = current.get_parent()
		depth += 1
	return false

func gs_layout_effective_z(item: CanvasItem) -> int:
	var total := item.z_index
	var current := item
	var depth := 0
	while current.z_as_relative and depth < GS_LAYOUT_MAX_DEPTH:
		var parent := current.get_parent()
		if parent is CanvasItem:
			total += (parent as CanvasItem).z_index
			current = parent as CanvasItem
		else:
			break
		depth += 1
	return total

func gs_layout_collect_controls(entry: Node, out: Array, state: Dictionary) -> void:
	var stack: Array = [entry]
	var seen := 0
	while not stack.is_empty():
		if seen >= GS_LAYOUT_MAX_NODES or out.size() >= GS_LAYOUT_MAX_CONTROLS:
			return
		var current: Node = stack.pop_back()
		seen += 1
		if current is BaseButton or current is LineEdit or current is TextEdit:
			out.append(current)
			state['inspected'] = int(state.get('inspected', 0)) + 1
		for child in current.get_children():
			stack.append(child)

func gs_layout_scan_entry(entry: Node, root_node: Node, report: Callable, state: Dictionary) -> void:
	var controls: Array = []
	gs_layout_collect_controls(entry, controls, state)
	for target in controls:
		if int(state.get('warnings', 0)) >= GS_LAYOUT_MAX_WARNINGS or int(state.get('pairs', 0)) >= GS_LAYOUT_MAX_PAIRS:
			return
		gs_layout_scan_target(target, root_node, report, state)

func gs_layout_scan_target(target: Node, root_node: Node, report: Callable, state: Dictionary) -> void:
	var control := target as Control
	if control == null or not control.is_visible_in_tree():
		return
	if not gs_layout_is_actionable(control):
		return
	if control.size.x < 1.0 or control.size.y < 1.0:
		return
	if gs_layout_has_complex_transform(control, root_node):
		return
	var rect: Rect2 = control.get_global_rect()
	if rect.size.x < 1.0 or rect.size.y < 1.0:
		return
	var node_path := gs_layout_node_path(root_node, control)
	var subject := control.get_class() + ' "' + control.name + '" (' + node_path + ')'
	gs_layout_scan_clipping(control, rect, subject, node_path, report, state)
	gs_layout_scan_viewport(control, subject, node_path, report, state)
	gs_layout_scan_overlap(control, rect, subject, node_path, root_node, report, state)

func gs_layout_scan_clipping(control: Control, rect: Rect2, subject: String, node_path: String, report: Callable, state: Dictionary) -> void:
	if int(state.get('warnings', 0)) >= GS_LAYOUT_MAX_WARNINGS:
		return
	# A top_level control positions itself outside its parent's canvas chain, so
	# ancestor clip rects are not comparable; the viewport check still runs.
	if control.top_level:
		return
	var visible_rect := rect
	var clipper := ''
	var scroll_clipper := ''
	var scrolled := false
	var current := control.get_parent()
	var depth := 0
	while current != null and depth < GS_LAYOUT_MAX_DEPTH:
		if current is Viewport:
			break
		if current is CanvasLayer:
			if gs_layout_canvas_layer_remaps(current):
				break
		elif current is Control:
			var box := current as Control
			if box.clip_contents:
				visible_rect = visible_rect.intersection(box.get_global_rect())
				if clipper.is_empty():
					clipper = box.name
				if box is ScrollContainer:
					scrolled = true
					if scroll_clipper.is_empty():
						scroll_clipper = box.name
		current = current.get_parent()
		depth += 1
	var area := rect.get_area()
	if area < 1.0:
		return
	var kept := visible_rect.get_area()
	if kept <= 0.0:
		if scrolled:
			return
		state['warnings'] = int(state.get('warnings', 0)) + 1
		report.call('clip', subject, ' lies outside its visible area' + (' (clipped by "' + clipper + '")' if not clipper.is_empty() else '') + ' and no ScrollContainer can scroll it into view.', node_path)
		return
	var frac := kept / area
	if frac < GS_LAYOUT_MIN_VISIBLE_FRAC:
		state['warnings'] = int(state.get('warnings', 0)) + 1
		if scrolled:
			report.call('clip', subject, ' is only ' + str(int(100.0 * frac)) + '% visible inside its ScrollContainer ("' + scroll_clipper + '"); players may need to scroll to reach it.', node_path)
		else:
			report.call('clip', subject, ' is only ' + str(int(100.0 * frac)) + '% visible (clipped by "' + clipper + '").', node_path)

func gs_layout_scan_viewport(control: Control, subject: String, node_path: String, report: Callable, state: Dictionary) -> void:
	if int(state.get('warnings', 0)) >= GS_LAYOUT_MAX_WARNINGS:
		return
	var bounds: Rect2 = control.get_viewport_rect()
	if bounds.size.x < 1.0 or bounds.size.y < 1.0:
		return
	var shown: Rect2 = (control.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, control.size)).abs()
	var area := shown.get_area()
	if area < 1.0:
		return
	var kept := shown.intersection(bounds).get_area()
	if kept <= 0.0:
		if gs_layout_in_scroll(control):
			return
		state['warnings'] = int(state.get('warnings', 0)) + 1
		report.call('viewport', subject, ' lies outside the ' + str(int(bounds.size.x)) + 'x' + str(int(bounds.size.y)) + ' viewport and no ScrollContainer can scroll it into view.', node_path)
		return
	var frac := kept / area
	if frac < GS_LAYOUT_MIN_VISIBLE_FRAC:
		state['warnings'] = int(state.get('warnings', 0)) + 1
		report.call('viewport', subject, ' extends outside the ' + str(int(bounds.size.x)) + 'x' + str(int(bounds.size.y)) + ' viewport; only ' + str(int(100.0 * frac)) + '% is visible.', node_path)

func gs_layout_scan_overlap(control: Control, rect: Rect2, subject: String, subject_path: String, root_node: Node, report: Callable, state: Dictionary) -> void:
	if control.show_behind_parent:
		return
	var area := rect.get_area()
	if area < 1.0:
		return
	var view := control.get_viewport()
	var control_z := gs_layout_effective_z(control)
	var canvas_home := gs_layout_canvas_root(control)
	var level: Node = control
	var depth := 0
	while level != null and depth < GS_LAYOUT_MAX_DEPTH:
		if int(state.get('warnings', 0)) >= GS_LAYOUT_MAX_WARNINGS or int(state.get('pairs', 0)) >= GS_LAYOUT_MAX_PAIRS:
			return
		var parent := level.get_parent()
		if parent == null or parent is Viewport:
			return
		var siblings := parent.get_children()
		var index := siblings.find(level) + 1
		while index < siblings.size():
			if int(state.get('warnings', 0)) >= GS_LAYOUT_MAX_WARNINGS or int(state.get('pairs', 0)) >= GS_LAYOUT_MAX_PAIRS:
				return
			if gs_layout_scan_occluder(siblings[index], parent, rect, area, control_z, view, canvas_home, subject, subject_path, root_node, report, state):
				return
			index += 1
		if parent is CanvasLayer or parent is SubViewport:
			return
		level = parent
		depth += 1

func gs_layout_scan_occluder(candidate: Node, stop_parent: Node, rect: Rect2, area: float, control_z: int, view: Viewport, canvas_home: Node, subject: String, subject_path: String, root_node: Node, report: Callable, state: Dictionary) -> bool:
	var stack: Array = [candidate]
	var seen := 0
	while not stack.is_empty():
		if int(state.get('warnings', 0)) >= GS_LAYOUT_MAX_WARNINGS or int(state.get('pairs', 0)) >= GS_LAYOUT_MAX_PAIRS:
			return false
		if seen >= GS_LAYOUT_MAX_OCCLUDER_NODES:
			return false
		var node: Node = stack.pop_back()
		seen += 1
		if node is CanvasLayer:
			continue
		if node is Control:
			var box := node as Control
			if box.is_visible_in_tree() and gs_layout_is_occluder(box) and box.get_viewport() == view and gs_layout_effective_z(box) == control_z and not box.show_behind_parent and gs_layout_effective_alpha(box) >= GS_LAYOUT_MIN_ALPHA and gs_layout_canvas_root(box) == canvas_home and not gs_layout_path_complex(box, stop_parent):
				state['pairs'] = int(state.get('pairs', 0)) + 1
				var overlap := rect.intersection(box.get_global_rect())
				var overlap_frac := overlap.get_area() / area
				if overlap_frac >= GS_LAYOUT_MIN_OVERLAP_FRAC:
					state['warnings'] = int(state.get('warnings', 0)) + 1
					report.call('overlap-risk', subject, ' may be obscured by later sibling ' + box.get_class() + ' "' + box.name + '" (' + gs_layout_node_path(root_node, box) + ') (overlap risk: ' + str(int(100.0 * overlap_frac)) + '% overlaps; visual occlusion not proven from geometry).', subject_path)
					return true
		for child in node.get_children():
			stack.append(child)
	return false
`;
