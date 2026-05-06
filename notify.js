// =====================================================================
// LKOGY Notifier — يشتغل على GitHub Actions كل 5 دقائق
//   يفحص المنتجات الجديدة ويبعت إشعار FCM فقط
// =====================================================================

const admin = require("firebase-admin");

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa) });

const db        = admin.firestore();
const messaging = admin.messaging();

// =====================================================================
// helpers
// =====================================================================
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
// إشعار المنتجات الجديدة فقط
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

    // لو أول مرة نحفظ قائمة المنتجات بدون إرسال إشعارات
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
        const title    = "🛍️ منتج جديد في LKOGY Shop";
        const priceTxt = product.price ? ` بـ ${product.price} لكوجي` : "";
        const body     = `"${product.name || "منتج جديد"}"${priceTxt} نزل دلوقتي! خش شوفه قبل ما يخلص 🔥`;
        const image    = product.image || undefined;

        // فلترة حسب الجنس أو المرحلة لو موجودة في بيانات المستخدم
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

    // تحديث قائمة المنتجات المعروفة
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

    const invalid = await processNewProducts(allTokens);

    await cleanupInvalid(invalid);

    console.log("✅ Done.");
})().catch((err) => {
    console.error("❌ Fatal:", err);
    process.exit(1);
});
