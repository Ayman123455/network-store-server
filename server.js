const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  : require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const app = express();
//const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());

// مسار لوحة التحكم
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// مسار معالجة الشراء وتخزين الطلب
app.post('/api/orders/purchase', async (req, res) => {
  try {
    const { phone_number, wallet_index, reference_number, total_amount, items } = req.body;

    if (!reference_number || !items || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'بيانات الطلب غير مكتملة',
      });
    }

    const orderRefId = String(reference_number);

    // تم التعديل: فك تجميع العناصر المكررة بحسب الكمية (quantity)
    let processedItems = [];
    items.forEach(item => {
      const qty = item.quantity || 1;
      for (let i = 0; i < qty; i++) {
        processedItems.push({
          name: item.name || (item.card ? item.card.name : 'كرت شبكة'),
          price: item.price || (item.card ? item.card.price : 0),
          code: item.code || `PIN-${Math.floor(100000 + Math.random() * 900000)}`
        });
      }
    });

    await db.collection('orders').doc(orderRefId).set({
      phoneNumber: phone_number,
      walletIndex: wallet_index,
      referenceNumber: orderRefId,
      totalAmount: total_amount,
      items: processedItems, // حفظ المصفوفة المكتملة بحسب العدد الفعلي
      status: 'pending',
      createdAt: new Date(),
    });

    console.log(`[طلب جديد] مرجع رقم: ${orderRefId} - عدد الكروت: ${processedItems.length}`);

    const generatedCodes = processedItems.map(item => item.code);

    return res.status(200).json({
      success: true,
      message: 'تم تسجيل الطلب بنجاح وبانتظار الموافقة',
      order_id: orderRefId,
      codes: generatedCodes,
    });

  } catch (error) {
    console.error('خطأ في السيرفر:', error);
    return res.status(500).json({
      success: false,
      message: 'حدث خطأ أثناء حفظ الطلب',
    });
  }
});
// إنشاء مسار استقبال إشعار الرسائل النصية
app.post('/api/sms-webhook', async (req, res) => {
  try {
    // 1. استقبال نص الرسالة الممررة من تطبيق الهاتف
    const smsContent = req.body.message || req.body.text || '';
    console.log('وصلت رسالة جديدة:', smsContent);

    // 2. استخراج رقم المرجع والمبلغ باستخدام الـ Regex
    // يطابق كلمات مثل: مرجع، عملية، TRX متبوعة بالأرقام
    const refMatch = smsContent.match(/(?:مرجع|مرجعي|رقم العملية|Trx|Ref)[\s:]*([0-9]+)/i);
    const amountMatch = smsContent.match(/(?:مبلغ|بقيمت|بقيمة)[\s:]*([0-9]+)/i);

    if (!refMatch || !amountMatch) {
      return res.status(400).json({ error: 'تعذر استخراج رقم المرجع أو المبلغ' });
    }

    const extractedRef = refMatch[1].trim();
    const extractedAmount = parseInt(amountMatch[1].trim(), 10);

    // 3. البحث عن الطلب المعلق في Firestore برقم المرجع
    const ordersRef = admin.firestore().collection('orders');
    const snapshot = await ordersRef
      .where('referenceNumber', '==', extractedRef)
      .where('status', '==', 'pending')
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'الطلب غير موجود أو تمت معالجته سابقاً' });
    }

    const orderDoc = snapshot.docs[0];
    const orderData = orderDoc.data();

    // 4. المطابقة والتحقق من المبلغ
    if (orderData.totalAmount !== extractedAmount) {
      await orderDoc.ref.update({
        status: 'rejected',
        rejectionReason: 'المبلغ المحول غير مطابق للمطلوب'
      });
      return res.status(400).json({ error: 'المبلغ غير مطابق، تم رفض الطلب' });
    }

    // 5. التحديث التلقائي إلى approved
    await orderDoc.ref.update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`تمت الموافقة التلقائية على الطلب رقم: ${extractedRef}`);
    return res.status(200).json({ success: true, message: 'تم التحقق بنجاح' });

  } catch (error) {
    console.error('خطأ في السيرفر:', error);
    return res.status(500).json({ error: 'حدث خطأ داخلي' });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 السيرفر يعمل بنجاح على: http://localhost:${PORT}`);
  console.log(`🖥️ لوحة التحكم متاحة على: http://localhost:${PORT}/admin`);
});