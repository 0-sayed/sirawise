/**
 * Words that carry no signal in a keyword-coverage comparison.
 *
 * Two groups: ordinary English function words, and the boilerplate every posting shares —
 * "equal opportunity employer", "competitive salary", "fast-paced environment". A resume gains
 * nothing by matching the parts of a posting that are identical across every posting.
 */
const FUNCTION_WORDS =
	"a about above across after again against all almost along already also although always am among an and another " +
	"any anyone anything are around as at back be became because become been before began begin behind being below " +
	"beside besides best better between both but by came can cannot come could did do does doing done down during " +
	"each either else enough etc even ever every everything few for from further get give go going good got had half " +
	"has have having he her here hers herself him himself his how however i if in inside instead into is it its " +
	"itself just keep kind know large last later least left less let like likely little long made make many may me " +
	"might mine more most much must my myself near need never new next no nor not now of off often on once one only " +
	"onto or other others our ours out outside over own per perhaps please plus rather really right same say see " +
	"seem set several shall she should since so some something soon still such than that the their theirs them " +
	"themselves then there these they thing think this those though three through throughout thus to together too " +
	"toward towards two under until up upon us use used using very via was way we well went were what when where " +
	"whether which while who whom whose why will with within without would yet you your yours yourself";

const RECRUITING_BOILERPLATE =
	"bonus deep demonstrated detail driven eager excellent exceptional familiar familiarity great hands hands-on " +
	"knowledge expert expertise experienced fluent comfortable strong-plus " +
	"ideally including keen looking love nice offering outstanding package passion plus preferably proven required " +
	"solid strong track understanding well willing " +
	"ability applicant applicants apply application balance benefits candidate candidates career color colour " +
	"company compensation competitive culture disability diverse diversity dynamic employee employer employment " +
	"environment equal ethnicity excellent experience fast fast-paced gender growth identity inclusion inclusive " +
	"individual job join life location marital minimum must national opportunity opportunities orientation " +
	"package paced paid parental passionate pay people plus preferred qualification qualifications qualified race " +
	"regard religion remote required requirement requirements responsibilities responsibility role roles salary " +
	"seeking sex sexual skills status team teams thrive time title veteran welcome work working workplace years";

// Arabic prepositions, pronouns, demonstratives, conjunctions and other function words.
const ARABIC_FUNCTION_WORDS =
	"من إلى الى عن على علي في حتى مع بين عند لدى لدي دون خلال نحو حول فوق تحت أمام امام خلف بعد قبل منذ عبر بحسب " +
	"أجل اجل بالإضافة بالاضافة أيا أية أي اي ايا اية كل كلا كلتا أحد احد إحدى احدى بعض غير سوى مثل نفس ذلك هذا هذه هذان هاتان هؤلاء أولئك اولئك تلك هنا هناك هنالك " +
	"الذي التي الذين اللاتي اللائي اللواتي اللتان اللذان اللتين اللذين أنا انا أنت انت أنتم انتم أنتن انتن أنتما انتما هو هي هم هن هما نحن إياك إياه اياك اياه " +
	"إن ان أن كأن كان كانت كانوا يكون تكون يكن ليس ليست لست لن لم لا ما ماذا لماذا كيف أين اين متى هل إذ اذ إذا اذا لما بينما حيث حيثما حين حينما عندما " +
	"بل لكن ولكن إلا الا أو او أم ام ثم كما وكذلك كذا أيضا ايضا بلى نعم قد وقد فقد لقد لكي كي لعل ربما إما اما أما وإنما وانما طالما " +
	"بها به بهم فيه فيها منهم منها عليها عليه عليهم إليهم إليها اليهم اليها عنها عنه عنهم معه معها بينهما بعده بعدها عندها عنده بدون";

export const JD_STOPWORDS: ReadonlySet<string> = new Set(
	[...FUNCTION_WORDS.split(" "), ...RECRUITING_BOILERPLATE.split(" "), ...ARABIC_FUNCTION_WORDS.split(" ")].filter(
		Boolean,
	),
);
