/**
 * Emoji for the page icon picker and the `:name` shortcut while typing. A curated set (no
 * dependency): the common ones people pick for page icons and use in notes. Stored as the
 * character itself, so the Markdown stays plain text.
 */
export interface Emoji {
  e: string;
  /** Shortcode, as typed after ":" (`:rocket:`). */
  n: string;
  /** Extra search words. */
  k?: string;
  /** Picker group. */
  g: "Smileys" | "People" | "Nature" | "Food" | "Activity" | "Travel" | "Objects" | "Symbols";
}

const S = (g: Emoji["g"], rows: Array<[string, string, string?]>): Emoji[] => rows.map(([e, n, k]) => ({ e, n, k, g }));

export const EMOJI: Emoji[] = [
  ...S("Smileys", [
    ["😀", "grinning", "smile happy"], ["😃", "smiley", "happy"], ["😄", "smile", "happy joy"], ["😁", "grin"], ["😆", "laughing", "lol"],
    ["😅", "sweat_smile", "phew"], ["😂", "joy", "lol tears"], ["🙂", "slight_smile"], ["😉", "wink"], ["😊", "blush"],
    ["😇", "innocent", "angel"], ["🥰", "smiling_hearts", "love"], ["😍", "heart_eyes", "love"], ["🤩", "star_struck", "wow"], ["😘", "kissing_heart"],
    ["😋", "yum"], ["😎", "sunglasses", "cool"], ["🤓", "nerd"], ["🧐", "monocle", "inspect"], ["🤔", "thinking", "hmm"],
    ["🤨", "raised_eyebrow"], ["😐", "neutral"], ["😑", "expressionless"], ["😶", "no_mouth"], ["🙄", "eye_roll"],
    ["😏", "smirk"], ["😴", "sleeping", "zzz"], ["😌", "relieved"], ["😛", "tongue"], ["😜", "wink_tongue"],
    ["🤪", "zany"], ["😒", "unamused"], ["😓", "sweat"], ["😔", "pensive"], ["😕", "confused"],
    ["🙃", "upside_down"], ["🤑", "money_mouth"], ["😲", "astonished"], ["😮", "open_mouth", "surprised"], ["😱", "scream"],
    ["😭", "sob", "cry"], ["😢", "cry", "sad"], ["😤", "triumph"], ["😡", "rage", "angry"], ["🤯", "exploding_head", "mind blown"],
    ["😳", "flushed"], ["🥳", "partying", "party celebrate"], ["🥺", "pleading"], ["🤗", "hugging"], ["🤫", "shushing", "quiet secret"],
    ["🤐", "zipper_mouth", "secret"], ["😷", "mask", "sick"], ["🤒", "thermometer_face", "ill"], ["🥶", "cold_face"], ["🥵", "hot_face"],
    ["😈", "smiling_imp", "devil"], ["💀", "skull", "dead"], ["👻", "ghost"], ["👽", "alien"], ["🤖", "robot", "bot ai"],
    ["💩", "poop"], ["😺", "smiley_cat", "cat"],
  ]),
  ...S("People", [
    ["👋", "wave", "hello hi"], ["🤚", "raised_back_of_hand"], ["✋", "hand", "stop"], ["👌", "ok_hand"], ["✌️", "v", "peace"],
    ["🤞", "crossed_fingers", "luck"], ["🤟", "love_you"], ["🤘", "metal", "rock"], ["👈", "point_left"], ["👉", "point_right"],
    ["👆", "point_up"], ["👇", "point_down"], ["👍", "+1", "thumbsup yes like"], ["👎", "-1", "thumbsdown no"], ["✊", "fist"],
    ["👊", "punch"], ["👏", "clap", "applause"], ["🙌", "raised_hands", "hooray"], ["🙏", "pray", "please thanks"], ["🤝", "handshake", "deal"],
    ["💪", "muscle", "strong"], ["🧠", "brain", "smart"], ["👀", "eyes", "look"], ["👁️", "eye"], ["🗣️", "speaking_head", "talk"],
    ["👤", "bust", "user person"], ["👥", "busts", "users team people"], ["🧑‍💻", "technologist", "developer coder"], ["👩‍💼", "office_worker", "manager"], ["🧑‍🏫", "teacher"],
    ["🧑‍🔬", "scientist"], ["🧑‍🎨", "artist", "designer"], ["🧑‍🚀", "astronaut"], ["🦸", "superhero"], ["🧙", "mage", "wizard"],
  ]),
  ...S("Nature", [
    ["🐶", "dog"], ["🐱", "cat"], ["🦊", "fox"], ["🐻", "bear"], ["🐼", "panda"], ["🐨", "koala"], ["🦁", "lion"], ["🐯", "tiger"],
    ["🐸", "frog"], ["🐵", "monkey"], ["🐔", "chicken"], ["🐧", "penguin"], ["🐦", "bird"], ["🦅", "eagle"], ["🦉", "owl"],
    ["🦋", "butterfly"], ["🐝", "bee", "busy"], ["🐞", "ladybug", "bug"], ["🐛", "bug", "caterpillar"], ["🐢", "turtle", "slow"],
    ["🐍", "snake", "python"], ["🐙", "octopus"], ["🐳", "whale", "docker"], ["🐬", "dolphin"], ["🦈", "shark"],
    ["🦄", "unicorn"], ["🌱", "seedling", "grow new"], ["🌿", "herb"], ["🍀", "four_leaf_clover", "luck"], ["🌳", "tree"],
    ["🌲", "evergreen"], ["🌵", "cactus"], ["🌸", "cherry_blossom", "flower"], ["🌻", "sunflower"], ["🌹", "rose"],
    ["🍁", "maple_leaf", "autumn"], ["🍄", "mushroom"], ["🌍", "earth", "world globe"], ["🌙", "moon", "night"], ["⭐", "star"],
    ["🌟", "glowing_star"], ["✨", "sparkles", "new magic"], ["⚡", "zap", "fast lightning"], ["🔥", "fire", "hot lit"], ["🌈", "rainbow"],
    ["☀️", "sunny", "sun"], ["⛅", "partly_sunny", "weather"], ["☁️", "cloud"], ["🌧️", "rain"], ["❄️", "snowflake", "cold"],
    ["🌊", "ocean", "wave water"], ["💧", "droplet", "water"],
  ]),
  ...S("Food", [
    ["🍎", "apple"], ["🍊", "orange"], ["🍋", "lemon"], ["🍌", "banana"], ["🍉", "watermelon"], ["🍇", "grapes"], ["🍓", "strawberry"],
    ["🍒", "cherries"], ["🍑", "peach"], ["🥑", "avocado"], ["🥕", "carrot"], ["🌽", "corn"], ["🍞", "bread"], ["🧀", "cheese"],
    ["🍕", "pizza"], ["🍔", "burger"], ["🌮", "taco"], ["🍣", "sushi"], ["🍜", "ramen", "noodles"], ["🍪", "cookie"],
    ["🎂", "cake", "birthday"], ["🍩", "doughnut"], ["🍫", "chocolate"], ["🍿", "popcorn"], ["☕", "coffee"], ["🍵", "tea"],
    ["🍺", "beer"], ["🍷", "wine"], ["🥂", "champagne", "cheers toast"], ["🧃", "juice"],
  ]),
  ...S("Activity", [
    ["⚽", "soccer", "football"], ["🏀", "basketball"], ["🏈", "american_football"], ["⚾", "baseball"], ["🎾", "tennis"],
    ["🏐", "volleyball"], ["🏓", "ping_pong"], ["🏆", "trophy", "win award"], ["🥇", "first_place", "gold medal"], ["🥈", "second_place"],
    ["🥉", "third_place"], ["🏅", "medal"], ["🎯", "dart", "target goal"], ["🎮", "video_game", "game"], ["🎲", "game_die", "dice random"],
    ["🧩", "puzzle", "integration"], ["🎨", "art", "design palette"], ["🎬", "clapper", "film movie"], ["🎤", "microphone", "talk"], ["🎧", "headphones", "music"],
    ["🎸", "guitar"], ["🎹", "piano"], ["🥁", "drum"], ["🎉", "tada", "party celebrate launch"], ["🎊", "confetti"],
    ["🎁", "gift", "present"], ["🎈", "balloon"], ["🎟️", "ticket"], ["🏃", "runner", "run"], ["🚴", "bike"],
  ]),
  ...S("Travel", [
    ["🚀", "rocket", "launch ship fast"], ["✈️", "airplane", "flight travel"], ["🚗", "car"], ["🚕", "taxi"], ["🚌", "bus"],
    ["🚆", "train"], ["🚲", "bicycle"], ["🛵", "scooter"], ["🚢", "ship"], ["⛵", "sailboat"], ["🛸", "ufo"],
    ["🚦", "traffic_light"], ["🚧", "construction", "wip"], ["⛽", "fuel"], ["🗺️", "map"], ["🧭", "compass", "direction"],
    ["🏔️", "mountain"], ["🏕️", "camping"], ["🏖️", "beach"], ["🏝️", "island"], ["🏠", "house", "home"],
    ["🏢", "office", "building company"], ["🏭", "factory"], ["🏥", "hospital"], ["🏦", "bank"], ["🏫", "school"],
    ["🌆", "city"], ["🌉", "bridge"], ["🗽", "statue_of_liberty"], ["🗼", "tower"], ["🏁", "checkered_flag", "finish race"],
  ]),
  ...S("Objects", [
    ["📄", "page", "doc document"], ["📃", "page_curl"], ["📑", "bookmark_tabs"], ["📝", "memo", "note write"], ["📋", "clipboard", "checklist"],
    ["📌", "pushpin", "pin"], ["📍", "round_pushpin", "location"], ["📎", "paperclip", "attachment"], ["✏️", "pencil", "edit"], ["🖊️", "pen"],
    ["📚", "books", "library docs"], ["📖", "book", "read guide"], ["📓", "notebook"], ["📒", "ledger"], ["🗂️", "card_index_dividers", "folders"],
    ["📁", "folder"], ["📂", "open_folder"], ["🗃️", "card_file_box", "archive"], ["🗄️", "file_cabinet"], ["🗒️", "spiral_notepad"],
    ["📅", "date", "calendar"], ["📆", "calendar", "schedule"], ["⏰", "alarm_clock", "time"], ["⏳", "hourglass", "wait"], ["⌛", "hourglass_done"],
    ["💡", "bulb", "idea tip"], ["🔦", "flashlight"], ["🔍", "mag", "search find"], ["🔎", "mag_right"], ["🔒", "lock", "private secure"],
    ["🔓", "unlock"], ["🔑", "key", "password"], ["🗝️", "old_key"], ["🛡️", "shield", "security"], ["⚙️", "gear", "settings config"],
    ["🛠️", "tools", "build fix"], ["🔧", "wrench", "fix"], ["🔨", "hammer", "build"], ["🧰", "toolbox"], ["🧪", "test_tube", "test experiment qa"],
    ["🔬", "microscope", "research"], ["🧬", "dna"], ["💻", "computer", "laptop dev"], ["🖥️", "desktop"], ["⌨️", "keyboard"],
    ["🖱️", "mouse"], ["📱", "iphone", "phone mobile"], ["☎️", "telephone"], ["📞", "phone_call"], ["📧", "email", "mail"],
    ["📨", "incoming_envelope"], ["📮", "postbox"], ["📦", "package", "box ship release"], ["🏷️", "label", "tag"], ["💰", "moneybag", "money"],
    ["💳", "credit_card", "payment billing"], ["💵", "dollar"], ["📈", "chart_up", "growth trend"], ["📉", "chart_down"], ["📊", "bar_chart", "chart stats analytics"],
    ["🧾", "receipt", "invoice"], ["💼", "briefcase", "work business"], ["🎓", "graduation", "learn"], ["🔔", "bell", "notification"], ["📣", "megaphone", "announce"],
    ["📢", "loudspeaker", "announcement"], ["💬", "speech_balloon", "comment chat"], ["💭", "thought_balloon"], ["🗨️", "speech_left"], ["📸", "camera_flash", "photo"],
    ["🎥", "movie_camera", "video"], ["📺", "tv"], ["📻", "radio"], ["🔋", "battery"], ["🔌", "plug", "integration"],
    ["💾", "floppy", "save"], ["💿", "cd"], ["🧲", "magnet"], ["🧯", "fire_extinguisher", "incident"], ["🩹", "bandage", "patch fix"],
    ["💊", "pill"], ["🧹", "broom", "cleanup"], ["🪄", "magic_wand", "magic"], ["🧭", "compass2", "navigate"], ["🗓️", "spiral_calendar", "plan"],
  ]),
  ...S("Symbols", [
    ["❤️", "heart", "love"], ["🧡", "orange_heart"], ["💛", "yellow_heart"], ["💚", "green_heart"], ["💙", "blue_heart"],
    ["💜", "purple_heart"], ["🖤", "black_heart"], ["🤍", "white_heart"], ["💯", "100", "perfect"], ["✅", "white_check_mark", "done yes check"],
    ["☑️", "ballot_box_with_check", "todo done"], ["✔️", "heavy_check_mark", "check"], ["❌", "x", "no cross wrong"], ["❎", "negative_squared_cross_mark"], ["⚠️", "warning", "caution"],
    ["🚫", "no_entry_sign", "forbidden"], ["⛔", "no_entry", "stop"], ["❗", "exclamation", "important"], ["❓", "question", "help"], ["💤", "zzz", "sleep"],
    ["🔴", "red_circle"], ["🟠", "orange_circle"], ["🟡", "yellow_circle"], ["🟢", "green_circle"], ["🔵", "blue_circle"],
    ["🟣", "purple_circle"], ["⚫", "black_circle"], ["⚪", "white_circle"], ["🟥", "red_square"], ["🟩", "green_square"],
    ["🟦", "blue_square"], ["⬆️", "arrow_up"], ["⬇️", "arrow_down"], ["➡️", "arrow_right"], ["⬅️", "arrow_left"],
    ["🔁", "repeat", "loop"], ["🔄", "arrows_counterclockwise", "sync refresh"], ["➕", "heavy_plus_sign", "add"], ["➖", "heavy_minus_sign"], ["ℹ️", "information_source", "info"],
    ["🆕", "new"], ["🆗", "ok"], ["🆘", "sos", "help"], ["🔗", "link"], ["#️⃣", "hash", "number"],
    ["♻️", "recycle"], ["⭕", "o", "circle"], ["🏳️", "white_flag"], ["🚩", "triangular_flag", "flag"], ["🎌", "crossed_flags"],
  ]),
];

/** Emoji whose name or keywords match `q` (name prefix first). */
export function searchEmoji(q: string, limit = 60): Emoji[] {
  const s = q.trim().toLowerCase().replace(/^:|:$/g, "");
  if (!s) return EMOJI.slice(0, limit);
  const scored: Array<[number, Emoji]> = [];
  for (const em of EMOJI) {
    const name = em.n.replace(/_/g, " ");
    const score = em.n.startsWith(s) ? 0 : name.split(" ").some((w) => w.startsWith(s)) ? 1 : (em.k ?? "").split(" ").some((w) => w.startsWith(s)) ? 2 : `${name} ${em.k ?? ""}`.includes(s) ? 3 : 9;
    if (score < 9) scored.push([score, em]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(([, e]) => e);
}

/** The emoji for an exact shortcode (`rocket`), else null. */
export function emojiByName(name: string): string | null {
  return EMOJI.find((e) => e.n === name.toLowerCase())?.e ?? null;
}
