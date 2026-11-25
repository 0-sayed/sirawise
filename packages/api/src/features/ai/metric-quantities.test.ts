import { expect, it } from "vite-plus/test";
import { assertHardFacts } from "./hard-facts";

const source = "Designed weekly quality reports and reduced preparation time by 22% using operational data.";

it.each([
	"Recorded a 22% reduction in reporting preparation time.",
	"Reduced preparation time by 22%.",
	"Recorded a 22% decrease in preparation time.",
	"Weekly quality report preparation time was reduced by 22% using operational data.",
])("keeps a percentage bound to its metric and direction: %s", (text) => {
	expect(() => assertHardFacts("", text, source)).not.toThrow();
});

it.each([
	"Recorded a 22% increase in preparation time.",
	"Recorded a 23% reduction in preparation time.",
	"Recorded a 22% reduction in revenue.",
	"Recorded a 22% reduction in preparation cost.",
	"Reduced revenue by 22%.",
	"Increased preparation time by 22%.",
])("rejects a changed percentage, metric or direction: %s", (text) => {
	expect(() => assertHardFacts("", text, source)).toThrow("AI_UNSUPPORTED_CLAIM");
});

const arabicSource =
	"مدير عمليات المنتجات وتحسين الخدمات بخبرة 20 عامًا في [redacted]، تشمل تنسيق العمليات وقيادة برامج التحسين. خفّض زمن إعداد التقارير بنسبة 22% من خلال توحيد متطلبات البيانات ومعايير المراجعة، ونسّق مراجعات شهرية مع 15 فريقًا، وربط مؤشرات الخدمة بسجل القرارات والمخاطر وخطة التحسين.";

it.each([
	"مدير عمليات المنتجات وتحسين الخدمات بخبرة 20 عامًا في تنسيق العمليات وقيادة برامج التحسين.",
	"مدير عمليات المنتجات وتحسين الخدمات بخبرة 20 عامًا تشمل تنسيق العمليات وقيادة برامج التحسين.",
	"خفّض زمن إعداد التقارير بنسبة 22% بتوحيد متطلبات البيانات ومعايير المراجعة، ونسّق مراجعات شهرية مع 15 فريقًا.",
	"خفّض زمن إعداد التقارير بنسبة 22% عبر توحيد متطلبات البيانات ومعايير المراجعة.",
	"حقق انخفاضًا بنسبة 22% في زمن إعداد التقارير.",
])("accepts Arabic duration and percentage-change paraphrases bound to the same metric: %s", (text) => {
	expect(() => assertHardFacts("", text, arabicSource)).not.toThrow();
});

it.each([
	"خفّض زمن إعداد التقارير بنسبة 25% بتوحيد متطلبات البيانات.",
	"زاد زمن إعداد التقارير بنسبة 22% بتوحيد متطلبات البيانات.",
	"خفّض زمن التدريب بنسبة 22% بتوحيد متطلبات البيانات.",
	"مدير عمليات المنتجات بخبرة 25 عامًا تشمل تنسيق العمليات.",
	"أدار 20 مشروعًا في تنسيق العمليات.",
])("rejects altered Arabic percentage, direction, metric, or duration unit: %s", (text) => {
	expect(() => assertHardFacts("", text, arabicSource)).toThrow("AI_UNSUPPORTED_CLAIM");
});
