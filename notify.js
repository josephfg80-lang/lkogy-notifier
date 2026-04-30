// =====================================================================
// LKOGY Notifier — يشتغل على GitHub Actions كل 5 دقائق
//   1) يفحص المنتجات الجديدة ويبعت إشعار FCM
//   2) يبعت تذكيرات المهام (15:00 و 20:00 بتوقيت القاهرة)
//   3) يبعت تذكيرات عجلة الحظ (18:00 و 20:00 و 23:00 بتوقيت القاهرة)
// =====================================================================

const admin = require("firebase-admin");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa) });

const db        = admin.firestore();
const messaging = admin.messaging();

// =====================================================================
// مواعيد التذكيرات بتوقيت القاهرة (DST بيتحسب تلقائياً عبر Intl)
// =====================================================================
const REMINDER_SLOTS = [
    {
        id:    "task-15",
        hour:  15,
        title: "☀️ تذكير العصر — INSTA LKOGY",
        body:  "علمت علي المهام؟ متنساش تعلم انهاردة 😉✨",
        tag:   "task-reminder",
        sound: "notice.mp3"
    },
    {
        id:    "task-20",
        hour:  20,
        title: "🌙 تذكير المساء — INSTA LKOGY",
        body:  "علمت علي المهام؟ متنساش تعلم انهاردة قبل ما اليوم يخلص 😉✨",
        tag:   "task-reminder",
        sound: "notice.mp3"
    },
    {
        id:    "wheel-18",
        hour:  18,
        title: "🎰 عجلة الحظ — لفّتك المجانية مستنياك!",
        body:  "ابدأ لفّتك دلوقتي وكسب لكوجي مجاناً 🍀🎁",
        tag:   "wheel-reminder",
        sound: "notice.mp3"
    },
    {
        id:    "wheel-20",
        hour:  20,
        title: "🎰 لسه ما لفّتش عجلة الحظ النهاردة؟",
        body:  "تذكير: لفّتك المجانية لسه مستنياك 🍀",
        tag:   "wheel-reminder",
        sound: "notice.mp3"
    },
    {
        id:    "wheel-23",
        hour:  23,
        title: "🚨 آخر فرصة! — عجلة الحظ",
        body:  "آخر ساعة قبل منتصف الليل — لف عجلة الحظ قبل ما الفرصة تخلص 🍀⏰",
        tag:   "wheel-reminder",
        sound: "notice.mp3"
    }
];

// =====================================================================
// helpers
// =====================================================================
function getCairoNow() {
    const fmt = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Cairo",
        year:  "numeric", month: "2-digit", day:    "2-digit",
        hour:  "2-digit", minute: "2-digit", hour12: false
    });
    const parts = fmt.formatToParts(new Date());
    const get   = (k) => parts.find((p) => p.type === k).value;
    return {
        date: `${get("year")}-${get("month")}-${get("day")}`,
        hour: parseInt(get("hour"),   10),
        min:  parseInt(get("minute"), 10)
    };
}

async function getAllTokenDocs() {
    const snap = await db.collection("fcmTokens").get();
    const list = [];
    snap.forEach((d) => {
        const data  = d.data() || {};
        const token = data.token || d.id;
        if (token) list.push({ token, ref: d.ref, data });
    });
    return list;
}

async function sendToTokens(targets, baseMessage, label) {
    if (targets.length === 0) {
        console.log(`   • ${label}: no targets.`);
        return { sent: 0, failed: 0, invalid: [] };
    }
    let sent = 0, failed = 0;
    const invalid = [];
    for (let i = 0; i < targets.length; i += 500) {
        const chunk  = targets.slice(i, i + 500);
        const tokens = chunk.map((t) => t.token);
        try {
            const res = await messaging.sendEachForMulticast({ tokens, ...baseMessage });
            res.responses.forEach((r, idx) => {
                if (r.success) {
                    sent++;
                } else {
                    failed++;
                    const code = (r.error && r.error.code) || "";
                    if (
                        code === "messaging/registration-token-not-registered" ||
                        code === "messaging/invalid-registration-token" ||
                        code === "messaging/invalid-argument"
                    ) {
                        invalid.push(chunk[idx].ref);
                    }
                }
            });
        } catch (err) {
            console.error(`   • ${label}: send error`, err.message);
            failed += chunk.length;
        }
    }
    console.log(`   • ${label}: sent=${sent}, failed=${failed}, targets=${targets.length}`);
    return { sent, failed, invalid };
}

async function cleanupInvalid(refs) {
    if (refs.length === 0) return;
    const uniq = Array.from(new Set(refs));
    for (let i = 0; i < uniq.length; i += 400) {
        const batch = db.batch();
        uniq.slice(i, i + 400).forEach((r) => batch.delete(r));
        try { await batch.commit(); } catch (e) { console.warn("cleanup err:", e.message); }
    }
    console.log(`🧹 Cleaned ${uniq.length} invalid token(s).`);
}

// =====================================================================
// 1) تذكيرات المهام و عجلة الحظ (مرة واحدة في كل slot يومياً)
// =====================================================================
async function processReminders(allTokens) {
    const cairo = getCairoNow();
    const slot  = REMINDER_SLOTS.find((s) => s.hour === cairo.hour);
    if (!slot) {
        console.log(`⏰ Cairo ${cairo.date} ${cairo.hour}:${String(cairo.min).padStart(2,"0")} — no reminder slot.`);
        return [];
    }

    // de-dupe: مش نبعت نفس الـ slot أكتر من مرة في نفس اليوم
    const stateRef = db.doc("_meta/reminderState");
    const snap     = await stateRef.get();
    const state    = snap.exists ? (snap.data() || {}) : {};
    if (state[slot.id] === cairo.date) {
        console.log(`✓ Slot ${slot.id} already sent today (${cairo.date}).`);
        return [];
    }

    console.log(`⏰ Sending ${slot.id} for ${cairo.date} (Cairo ${cairo.hour}:00)`);

    const baseMessage = {
        notification: { title: slot.title, body: slot.body },
        data: {
            type:  slot.id.startsWith("wheel") ? "wheel_reminder" : "task_reminder",
            title: slot.title,
            body:  slot.body,
            url:   "/",
            tag:   slot.tag,
            slot:  slot.id
        },
        webpush: {
            notification: {
                icon:     "web icon-modified.jpg",
                badge:    "web icon-modified.jpg",
                vibrate:  [250, 120, 250, 120, 400],
                requireInteraction: true,
                renotify: true,
                tag:      slot.tag,
                actions:  [{ action: "open", title: "افتح التطبيق" }]
            },
            fcmOptions: { link: "/" },
            headers:    { Urgency: "high", TTL: "21600" }   // صالح 6 ساعات
        }
    };

    const res = await sendToTokens(allTokens, baseMessage, slot.id);

    state[slot.id] = cairo.date;
    await stateRef.set(state, { merge: true });

    return res.invalid;
}

// =====================================================================
// 2) المنتجات الجديدة (نفس منطق الـ baseline)
// =====================================================================
async function processNewProducts(allTokens) {
    const productsSnap = await db.collection("products").get();
    const currentMap = {};
    const currentIds = [];
    productsSnap.forEach((d) => {
        currentMap[d.id] = d.data() || {};
        currentIds.push(d.id);
    });

    const stateRef  = db.doc("_meta/notifierState");
    const stateSnap = await stateRef.get();
    const known     = stateSnap.exists ? (stateSnap.data().knownIds || null) : null;

    if (!known) {
        await stateRef.set({
            knownIds: currentIds,
            lastRun:  admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`✅ First run — products baseline saved (${currentIds.length} items). No notifications.`);
        return [];
    }

    const knownSet = new Set(known);
    const newIds   = currentIds.filter((id) => !knownSet.has(id));

    if (newIds.length === 0) {
        await stateRef.set({
            knownIds: currentIds,
            lastRun:  admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        console.log("ℹ️ No new products this run.");
        return [];
    }

    console.log(`🆕 Found ${newIds.length} new product(s): ${newIds.join(", ")}`);

    const allInvalid = [];
    for (const productId of newIds) {
        const product  = currentMap[productId] || {};
        const title    = "🛍️ منتج جديد في lkogy shop";
        const priceTxt = product.price ? ` بـ ${product.price} لكوجي` : "";
        const body     = `${product.name || "منتج جديد"}${priceTxt} — افتح دلوقتي قبل ما يخلص 🔥`;
        const image    = product.image || undefined;

        const targets = allTokens.filter((t) => {
            if (product.gender && t.data.gender && product.gender !== t.data.gender) return false;
            if (product.stage && product.stage !== "all" && t.data.stage &&
                product.stage !== t.data.stage) return false;
            return true;
        });

        const baseMessage = {
            notification: { title, body, ...(image ? { imageUrl: image } : {}) },
            data: {
                type:      "new_product",
                productId: String(productId),
                url:       "/",
                tag:       "new-product-" + productId,
                title, body,
                ...(image ? { image } : {})
            },
            webpush: {
                notification: {
                    icon:    image || "web icon-modified.jpg",
                    badge:   "web icon-modified.jpg",
                    ...(image ? { image } : {}),
                    vibrate: [250, 120, 250, 120, 400],
                    requireInteraction: true,
                    renotify: true,
                    tag:     "new-product-" + productId,
                    actions: [{ action: "open", title: "🔥 شوفه دلوقتي" }]
                },
                fcmOptions: { link: "/" },
                headers:    { Urgency: "high", TTL: "86400" }
            }
        };

        const res = await sendToTokens(targets, baseMessage, "product:" + productId);
        allInvalid.push(...res.invalid);
    }

    await stateRef.set({
        knownIds: currentIds,
        lastRun:  admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    return allInvalid;
}

// =====================================================================
// MAIN
// =====================================================================
(async () => {
    const allTokens = await getAllTokenDocs();
    if (allTokens.length === 0) {
        console.log("⚠️ No FCM tokens registered yet — skipping all sends.");
        return;
    }
    console.log(`📱 ${allTokens.length} token(s) registered.`);

    const invalid1 = await processReminders(allTokens);
    const invalid2 = await processNewProducts(allTokens);

    await cleanupInvalid([...invalid1, ...invalid2]);

    console.log("✅ Done.");
})().catch((err) => {
    console.error("❌ Fatal:", err);
    process.exit(1);
});
