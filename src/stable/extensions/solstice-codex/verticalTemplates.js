"use strict";

const VERTICAL_TEMPLATE_CATALOG = [
	{ file: "verticals/fitness-coach.md", tags: ["fitness", "gym", "personal trainer", "fitness coach", "workout", "strength training", "pilates", "crossfit", "כושר", "מאמן כושר", "מאמנת כושר", "חדר כושר", "אימון אישי", "אימונים אישיים", "פילאטיס", "קרוספיט"] },
	{ file: "verticals/dental-clinic.md", tags: ["dentist", "dental", "dental clinic", "orthodontist", "orthodontics", "מרפאת שיניים", "רופא שיניים", "רופאת שיניים", "שיניים", "דנטלי", "יישור שיניים"] },
	{ file: "verticals/medical-clinic.md", tags: ["medical", "medical clinic", "clinic", "doctor", "physio", "healthcare", "health", "private clinic", "רפואה", "קליניקה רפואית", "מרפאה", "רופא", "רופאה", "פיזיותרפיה", "בריאות"] },
	{ file: "verticals/law-firm.md", tags: ["law", "lawyer", "legal", "attorney", "notary", "עו\"ד", "עו״ד", "עורך דין", "עורכת דין", "עורכי דין", "משרד עורכי דין", "נוטריון", "משפט"] },
	{ file: "verticals/barber-beauty.md", tags: ["barber", "barbershop", "hair salon", "salon", "hair", "tattoo", "מספרה", "מספרת גברים", "ספר גברים", "עיצוב שיער", "שיער", "קעקוע"] },
	{ file: "verticals/beauty-cosmetics.md", tags: ["beauty clinic", "beauty", "cosmetics", "cosmetic clinic", "aesthetics", "skincare", "nails", "קוסמטיקה", "קליניקת קוסמטיקה", "קוסמטיקאית", "טיפולי יופי", "אסתטיקה", "טיפוח", "ציפורניים"] },
	{ file: "verticals/restaurant.md", tags: ["restaurant", "bistro", "chef", "dining", "food", "reservations", "מסעדה", "ביסטרו", "שף", "אוכל", "הזמנת שולחן"] },
	{ file: "verticals/real-estate.md", tags: ["real estate", "realtor", "brokerage", "property", "properties", "נדל\"ן", "נדל״ן", "תיווך", "נכסים", "סוכן נדלן", "סוכנות נדלן"] },
	{ file: "verticals/ecommerce.md", tags: ["ecommerce", "e-commerce", "online store", "online shop", "shopify", "webshop", "חנות אונליין", "חנות אינטרנטית", "מסחר אלקטרוני", "איקומרס"] },
	{ file: "verticals/saas.md", tags: ["saas", "software as a service", "software product", "b2b software", "startup software", "תוכנת saas", "מוצר תוכנה", "סטארטאפ תוכנה"] },
	{ file: "verticals/portfolio.md", tags: ["portfolio", "creative portfolio", "designer portfolio", "photographer portfolio", "artist portfolio", "תיק עבודות", "פורטפוליו", "צלם", "מעצב עצמאי"] },
	{ file: "verticals/travel-agency.md", tags: ["travel agency", "tour operator", "travel advisor", "guided tours", "trips", "סוכנות טיולים", "סוכן נסיעות", "טיולים מאורגנים", "חבילות נופש", "תיירות"] },
	{ file: "verticals/jewelry.md", tags: ["jewelry", "jewellery", "jeweler", "fine jewelry", "online jewelry store", "diamond", "תכשיטים", "חנות תכשיטים", "חנות אונליין לתכשיטים", "צורף", "יהלומים"] },
	{ file: "verticals/education-courses.md", tags: ["education", "online course", "online courses", "course platform", "academy", "school", "קורסים אונליין", "קורס דיגיטלי", "מכללה", "אקדמיה", "לימודים"] },
	{ file: "verticals/events.md", tags: ["event production", "event planner", "events", "wedding planner", "conference", "הפקת אירועים", "מפיק אירועים", "אירועים", "חתונות", "כנסים"] },
	{ file: "verticals/renovation-services.md", tags: ["renovation", "remodeling", "general contractor", "home improvement", "carpentry", "repairs", "קבלן שיפוצים", "שיפוצים", "נגרות", "תיקונים", "בעלי מקצוע"] },
];

const LIBRARY_INTENT_RE = /\b(template|templates|vertical|verticals|sector|sectors|library|pack)\b|(?:תבנית|תבניות|ורטיקל|ורטיקלים|תחום|תחומים|ספרייה|חבילה)/i;

function selectVerticalTemplates(text) {
	const normalized = String(text || "").toLowerCase();
	const requested = LIBRARY_INTENT_RE.test(normalized);
	const ranked = VERTICAL_TEMPLATE_CATALOG.map((item, index) => {
		const matched = item.tags.filter((tag) => normalized.includes(String(tag).toLowerCase()));
		return { item, index, score: matched.reduce((best, tag) => Math.max(best, String(tag).length), 0) };
	}).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
	const templates = ranked.length ? [ranked[0].item] : [];
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
