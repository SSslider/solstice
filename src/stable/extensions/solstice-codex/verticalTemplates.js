"use strict";

const VERTICAL_TEMPLATE_CATALOG = [
	{ file: "verticals/fitness-coach.md", tags: ["fitness", "gym", "personal trainer", "fitness coach", "workout", "strength training", "pilates", "crossfit", "כושר", "מאמן כושר", "מאמנת כושר", "חדר כושר", "אימון אישי", "אימונים אישיים", "פילאטיס", "קרוספיט"] },
	{ file: "verticals/medical-clinic.md", tags: ["medical", "clinic", "doctor", "dentist", "dental", "physio", "health", "רופא", "רופאה", "מרפאה", "שיניים", "דנטלי", "פיזיותרפיה", "בריאות"] },
	{ file: "verticals/law-firm.md", tags: ["law", "lawyer", "legal", "attorney", "notary", "עו\"ד", "עו״ד", "עורך דין", "עורכת דין", "נוטריון", "משפט"] },
	{ file: "verticals/barber-beauty.md", tags: ["barber", "salon", "beauty", "hair", "nails", "tattoo", "מספרה", "ספר גברים", "יופי", "שיער", "ציפורניים", "קעקוע"] },
];

const LIBRARY_INTENT_RE = /\b(template|templates|vertical|verticals|sector|sectors|library|pack)\b|(?:תבנית|תבניות|ורטיקל|ורטיקלים|תחום|תחומים|ספרייה|חבילה)/i;

function selectVerticalTemplates(text) {
	const normalized = String(text || "").toLowerCase();
	const requested = LIBRARY_INTENT_RE.test(normalized);
	const templates = VERTICAL_TEMPLATE_CATALOG.filter((item) =>
		item.tags.some((tag) => normalized.includes(String(tag).toLowerCase()))
	);
	return {
		requested,
		templates,
		reason: requested && !templates.length ? "no confident vertical match" : templates.length ? "confident tag match" : "vertical not requested",
	};
}

function buildVerticalTemplatePack(text, loadTemplate) {
	const selection = selectVerticalTemplates(text);
	const blocks = selection.templates.map((item) => ({
		...item,
		body: String(loadTemplate(item.file) || "").trim(),
	})).filter((item) => item.body);
	return { ...selection, blocks, text: blocks.map((item) => item.body).join("\n\n---\n\n") };
}

module.exports = { VERTICAL_TEMPLATE_CATALOG, selectVerticalTemplates, buildVerticalTemplatePack };
