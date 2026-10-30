## The five calls this starter ships. Edit the text, the details and the replies;
## keep the shape: every call offers one warm reply (+1 trust), one steady reply
## (no change) and one cold reply (-1 trust and one cold mark). This is story
## content, not a dialogue framework: adding a sixth call means adding one entry
## here and raising GameState.CALL_COUNT (or passing a count to start_run).
extends RefCounted

const CALLS := [
	{
		"caller": "Mara",
		"role": "night bus driver",
		"line": "The last bus pulled away while I was helping a passenger. I'm stranded at the depot.",
		"detail": "She sounds more embarrassed than angry. Behind her, a timetable flaps in the wind.",
		"choices": [
			{
				"text": "Stay on the line. I'll find the next one with you.",
				"tone": "Warm",
				"trust": 1,
				"cold": 0,
				"reply": "You'd do that? Thank you. I can wait if someone is looking.",
			},
			{
				"text": "Read me the stop number and I'll check.",
				"tone": "Steady",
				"trust": 0,
				"cold": 0,
				"reply": "It's fourteen, by the old depot. I'll hold.",
			},
			{
				"text": "You should have boarded faster.",
				"tone": "Cold",
				"trust": -1,
				"cold": 1,
				"reply": "Right. Sorry I bothered you.",
			},
		],
	},
	{
		"caller": "Ivo",
		"role": "bakery owner",
		"line": "The flour delivery never came. I have a window full of empty trays and a queue outside.",
		"detail": "A metal tray clatters. He is trying not to sound worried.",
		"choices": [
			{
				"text": "I'll trace it and call you back within the hour.",
				"tone": "Warm",
				"trust": 1,
				"cold": 0,
				"reply": "An hour. Good. I can keep the coffee going until then.",
			},
			{
				"text": "Let's check the order number together.",
				"tone": "Steady",
				"trust": 0,
				"cold": 0,
				"reply": "It's on the invoice by the till. Give me a second.",
			},
			{
				"text": "That's not my department.",
				"tone": "Cold",
				"trust": -1,
				"cold": 1,
				"reply": "Then whose is it? Never mind. I'll close early.",
			},
		],
	},
	{
		"caller": "June",
		"role": "first-year student",
		"line": "My key card stopped working and the dorm office is closed. I've been outside for an hour.",
		"detail": "She has been standing in the rain. Her voice shakes once, then steadies.",
		"choices": [
			{
				"text": "I'll stay with you while we get the door open.",
				"tone": "Warm",
				"trust": 1,
				"cold": 0,
				"reply": "Okay. Thank you. I didn't want to wake anyone.",
			},
			{
				"text": "Read me the reference on your card.",
				"tone": "Steady",
				"trust": 0,
				"cold": 0,
				"reply": "It's J-204. I can read it again if that helps.",
			},
			{
				"text": "You should have called earlier.",
				"tone": "Cold",
				"trust": -1,
				"cold": 1,
				"reply": "I know. I just... okay. I'll find somewhere else.",
			},
		],
	},
	{
		"caller": "Oren",
		"role": "night nurse",
		"line": "I've been on since six. I just need someone to cover the desk for ten minutes.",
		"detail": "You can hear a monitor beep behind him. He is already halfway through an apology.",
		"choices": [
			{
				"text": "Take ten. I'll cover the desk.",
				"tone": "Warm",
				"trust": 1,
				"cold": 0,
				"reply": "Ten minutes. I'll be back before you notice.",
			},
			{
				"text": "Log it with your supervisor first.",
				"tone": "Steady",
				"trust": 0,
				"cold": 0,
				"reply": "I've logged it. I'll wait for the reply.",
			},
			{
				"text": "Everyone is tired tonight.",
				"tone": "Cold",
				"trust": -1,
				"cold": 1,
				"reply": "Of course. Forget I asked.",
			},
		],
	},
	{
		"caller": "Talia",
		"role": "late commuter",
		"line": "The last train is gone and the station is closing. I don't know anyone here.",
		"detail": "An announcement echoes across the platform. She is the only one left on it.",
		"choices": [
			{
				"text": "I'll find you a safe ride and stay on the line.",
				"tone": "Warm",
				"trust": 1,
				"cold": 0,
				"reply": "Please. I'll wait right by the ticket machine.",
			},
			{
				"text": "Where exactly are you standing?",
				"tone": "Steady",
				"trust": 0,
				"cold": 0,
				"reply": "The east entrance, under the clock. I can see the street.",
			},
			{
				"text": "Should have left earlier.",
				"tone": "Cold",
				"trust": -1,
				"cold": 1,
				"reply": "Yes. I know. I'll figure it out.",
			},
		],
	},
]
