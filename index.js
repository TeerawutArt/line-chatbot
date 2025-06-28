const express = require('express');
const { Client } = require('@line/bot-sdk');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 9999;
const ngrok = require('ngrok');
// ตั้งค่าการเชื่อมต่อ LINE API
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_SECRET,
};

const client = new Client(config);
app.use(express.json());

// AI Settings
const aiName = 'อาร์ท'; // ชื่อ AI
const geminiModel = 'gemini-2.5-flash'; // ใช้โมเดล Gemini 2.5 Flash (มันใช้ได้อยู่ แต่ช้ามาก 1.5,2.0 ไวกว่า)
const aiUnknownErrorResponse = 'ขออภัยครับ ตอนนี้ยังไม่ฉลาดพอที่จะตอบคำถามนี้ได้ครับ';
const aiUnknownImageResponse = 'ขออภัยครับ ไม่สามารถวิเคราะห์รูปภาพนี้ได้ กรุณาลองรูปภาพอื่นหรือส่งข้อความแทนครับ';
const aiErrorMessage = 'ขออภัยครับ มีการเรียกใช้งานมากเกินไป ลองใหม่อีกครั้งในภายหลังนะครับ';

// --- Start ngrok for local development (อันนี้ไว้สำหรับรัน server บนเครื่อง ไว้ทดสอบ debug ไม่จำเป็นต้องเปิด) ---
/* (async function () {
  console.log('Starting ngrok...');
  const url = await ngrok.connect({
    addr: PORT,
    authtoken: process.env.NGROK_AUTH_TOKEN,
    region: 'ap',
  });
  console.log(`Ngrok is running at ${url}`);
});
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
}); */
// --- Helper Functions for Gemini API ---

/**

 * @param {string} userMessage 
 * @returns {string} 
 */
function createTextPrompt(userMessage) {
  // คำสั่งสำหรับ AI: ตรงนี้ไว้สำหรับกำหนดบุคลิกและรูปแบบการตอบกลับ
  return `คุณคือผู้ช่วย AI เป็นผู้ชายชื่อ '${aiName}' ช่วยตอบคำถามนี้แบบสุภาพ กระชับ และเป็นกันเอง ใช้หางเสียง 'ครับ' และห้ามใช้ Markdown (เช่น ** หรือ *): "${userMessage}"`;
}

/**
 * สร้าง Prompt สำหรับวิเคราะห์รูปภาพ
 * @returns {string} - Prompt สำหรับวิเคราะห์รูปภาพพร้อมคำสั่งกำหนดบุคลิก
 */
function createImagePrompt() {
  return `คุณคือผู้ช่วย AI เป็นผู้ชายชื่อ '${aiName}' ช่วยตอบคำถามนี้แบบสุภาพ กระชับ และเป็นกันเอง ใช้หางเสียง 'ครับ' และห้ามใช้ Markdown (เช่น ** หรือ *): กรุณาวิเคราะห์รูปภาพที่แนบมาและตอบคำถามเกี่ยวกับมัน`;
}

// --- Gemini API Call Functions ---

/**
 * @param {string} userMessage
 * @returns {Promise<string>}
 */
async function callGeminiAPI(userMessage) {
  const prompt = createTextPrompt(userMessage);
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || aiUnknownErrorResponse;
    return aiResponse.trim(); // .trim() เพื่อลบช่องว่างที่ไม่จำเป็น
  } catch (error) {
    console.error('Error calling Gemini API:', error.response?.data || error.message); //สำหรับทดสอบ ngrok
    return aiErrorMessage;
  }
}

/**

 * @param {string} prompt 
 * @returns {Promise<Buffer|null>} 
 */
//ใช้ Hugging Face diffusion สำหรับสร้างรูปภาพจากข้อความ (เหมือน gemini ยังไม่ support การสร้างรูปภาพจากข้อความ ผ่าน API (ถ้ามีบอกด้วยหาไม่เจอ) )
async function generateImage(prompt) {
  try {
    // แปล prompt เป็นภาษาอังกฤษสำหรับการ generate รูปภาพ (ตัวที่ใช้มันไม่รองรับภาษาไทย)
    const englishPrompt = await translateToEnglish(prompt);
    console.log(`Translated prompt: ${englishPrompt}`); //สำหรับ debug

    const response = await axios.post(
      'https://api-inference.huggingface.co/models/stabilityai/stable-diffusion-xl-base-1.0',
      {
        inputs: englishPrompt,
        parameters: {
          num_inference_steps: 20,
          guidance_scale: 7.5,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'image/png',
        },
        responseType: 'arraybuffer',
      }
    );

    // ตรวจสอบว่า response เป็นรูปภาพหรือ error message
    const contentType = response.headers['content-type'];
    if (contentType && contentType.includes('image')) {
      return Buffer.from(response.data);
    } else {
      // ถ้าไม่ใช่รูปภาพ แสดงว่าเป็น error message
      const errorMessage = Buffer.from(response.data).toString('utf-8');
      console.error('Hugging Face API Error:', errorMessage);

      // ตรวจสอบว่าเป็น model loading error หรือไม่
      if (errorMessage.includes('loading') || errorMessage.includes('currently loading')) {
        console.log('Model is loading, will retry with a different model...');
        // ลองใช้ model อื่นที่เร็วกว่า
        return await generateImageWithFallback(englishPrompt);
      }

      return null;
    }
  } catch (error) {
    console.error('Error generating image:', error.response?.data || error.message);

    if (error.response && error.response.data) {
      //แปลง error เป็นข้อความ (มันส่ง error เป็น binary data)
      const errorMessage = Buffer.from(error.response.data).toString('utf-8');
      console.error('Detail error:', errorMessage);
    }

    return null;
  }
}

/**
//Model สำรอง ถ้าไอ้ตัวข้างบนมันใช้ไม่ได้
 * @param {string} englishPrompt 
 * @returns {Promise<Buffer|null>} 
 */
async function generateImageWithFallback(englishPrompt) {
  try {
    console.log('Trying fallback model: runwayml/stable-diffusion-v1-5'); //สำหรับ debug

    const response = await axios.post(
      'https://api-inference.huggingface.co/models/runwayml/stable-diffusion-v1-5',
      {
        inputs: englishPrompt,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.HUGGINGFACE_API_KEY}`,
          'Content-Type': 'application/json',
          Accept: 'image/png',
        },
        responseType: 'arraybuffer',
      }
    );

    const contentType = response.headers['content-type'];
    if (contentType && contentType.includes('image')) {
      return Buffer.from(response.data);
    } else {
      const errorMessage = Buffer.from(response.data).toString('utf-8');
      console.error('Fallback model error:', errorMessage);
      return null;
    }
  } catch (error) {
    console.error('Fallback model also failed:', error.message);
    return null;
  }
}

/**
//ฟังก์ชั่นสำหรับแปลข้อความเป็นภาษาอังกฤษ ใช้ตัว 1.5 หรือ 2.0  พอ (ตัว 1.5 มันให้จำนวนreqน้อยกว่า 2.0 งงมาก: 1.5ให้50 2.0ให้200 2.5ให้250 ต่อวัน)

 * @param {string} thaiText 
 * @returns {Promise<string>} 
 */
async function translateToEnglish(thaiText) {
  try {
    const translatePrompt = `แปลข้อความนี้เป็นภาษาอังกฤษสำหรับใช้สร้างรูปภาพ AI และปรับปรุงให้เหมาะสมกับการอธิบายภาพ: "${thaiText}"`;

    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: translatePrompt }] }],
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const translation = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || thaiText;
    return translation.trim();
  } catch (error) {
    console.error('Error translating text:', error);
    return thaiText; // ใช้ข้อความเดิมหากแปลไม่ได้ (fallback)
  }
}

/**
 * ฟังก์ชัน สำหรับวิเคราะห์รูปภาพ (ใช้ตัว 1.5 จะได้แบ่งๆ quota ไม่ให้หมดเร็วเกินไป )
 * @param {string} imageBase64
 * @returns {Promise<string>}
 */
async function callGeminiAPIWithImage(imageBase64) {
  const prompt = createImagePrompt();
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        // แก้ไขโครงสร้างการส่งข้อมูลให้ถูกต้องตามเอกสารของ Gemini API
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: 'image/jpeg', // แก้ไข key เป็น camelCase
                  data: imageBase64,
                },
              },
            ],
          },
        ],
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    const aiResponse = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || aiUnknownImageResponse;
    return aiResponse.trim();
  } catch (error) {
    console.error('Error calling Gemini API with image:', error.response?.data || error.message);
    return aiErrorMessage;
  }
}

// --- LINE Server Functions ---

/**
 * ฟังก์ชันดาวน์โหลดรูปจาก LINE Server และแปลงเป็น Base64
 * @param {string} messageId - ID ของข้อความรูปภาพ
 * @returns {Promise<string|null>} - รูปภาพในรูปแบบ Base64 หรือ null หากเกิดข้อผิดพลาด
 */
async function getImageFromLine(messageId) {
  try {
    const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.LINE_ACCESS_TOKEN}` },
      responseType: 'arraybuffer',
    });
    return Buffer.from(response.data, 'binary').toString('base64');
  } catch (error) {
    console.error('Error downloading image from LINE:', error);
    return null;
  }
}

/**
 * ฟังก์ชัน upload รูปภาพไปยัง ImgBB (free image hosting service)
 * @param {Buffer} imageBuffer - ข้อมูลรูปภาพในรูปแบบ Buffer
 * @returns {Promise<string|null>} - URL ของรูปภาพที่ upload แล้ว หรือ null หากเกิดข้อผิดพลาด
 */
async function uploadImageToImgBB(imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');

    // ใช้ ImgBB API ฟรี (ต้องสมัคร API key ที่ https://api.imgbb.com/)
    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      {
        image: base64Image,
      },
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    return response.data?.data?.url || null;
  } catch (error) {
    console.error('Error uploading image to ImgBB:', error);

    // Fallback: ใช้ temporary image hosting service อื่น
    try {
      const formData = new FormData();
      formData.append('file', imageBuffer, 'generated-image.jpg');

      // ใช้ 0x0.st (temporary file hosting) เป็น fallback
      const fallbackResponse = await axios.post('https://0x0.st', formData, {
        headers: {
          ...formData.getHeaders(),
        },
      });

      return fallbackResponse.data.trim();
    } catch (fallbackError) {
      console.error('Error with fallback image hosting:', fallbackError);
      return null;
    }
  }
}

// --- Express Routes ---

app.post('/webhook', async (req, res) => {
  try {
    const events = req.body.events;
    // ใช้ Promise.all เพื่อจัดการ event ทั้งหมดพร้อมกัน
    await Promise.all(events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/**
 * ฟังก์ชันจัดการ Event ที่ได้รับจาก LINE Webhook
 * @param {object} event - Event object จาก LINE
 */
async function handleEvent(event) {
  if (event.type !== 'message') {
    return; // ไม่ใช่ event ที่เราสนใจ
  }

  let aiResponse;
  let imageBuffer = null;

  if (event.message.type === 'text') {
    const userMessage = event.message.text;

    // ตรวจสอบว่าเป็นคำสั่งขอ generate รูปภาพหรือไม่
    // คำสั่ง /image ข้อความที่ต้องการสร้างรูปภาพ
    const imageCommandRegex = /^\/image\s+(?:"([^"]+)"|(.+))$/i;
    const imageMatch = userMessage.match(imageCommandRegex);

    if (imageMatch) {
      // เป็นคำสั่งขอ generate รูปภาพ
      // ใช้ group 1 (มี quotes) หรือ group 2 (ไม่มี quotes)
      const imagePrompt = imageMatch[1] || imageMatch[2];
      aiResponse = `กำลังสร้างรูปภาพจากข้อความ: "${imagePrompt}" ครับ รอสักครู่นะครับ...`;

      // ส่งข้อความแจ้งว่ากำลังสร้างรูปภาพ
      await client.replyMessage(event.replyToken, {
        type: 'text',
        text: aiResponse,
      });

      // สร้างรูปภาพ
      console.log(`Starting image generation for prompt: "${imagePrompt}"`);
      imageBuffer = await generateImage(imagePrompt);

      if (imageBuffer) {
        // Upload รูปภาพไปยัง hosting service
        const imageUrl = await uploadImageToImgBB(imageBuffer);

        if (imageUrl) {
          // ส่งรูปภาพกลับไปยัง LINE โดยใช้ URL จริง
          await client.pushMessage(event.source.userId, {
            type: 'image',
            originalContentUrl: imageUrl,
            previewImageUrl: imageUrl,
          });
        } else {
          // แจ้งข้อผิดพลาดหากไม่สามารถ upload รูปภาพได้
          await client.pushMessage(event.source.userId, {
            type: 'text',
            text: 'ขออภัยครับ สร้างรูปภาพสำเร็จแล้วแต่ไม่สามารถอัปโหลดได้ในขณะนี้ กรุณาลองใหม่อีกครั้งครับ',
          });
        }
      } else {
        // แจ้งข้อผิดพลาดหากสร้างรูปภาพไม่สำเร็จ
        await client.pushMessage(event.source.userId, {
          type: 'text',
          text: 'ขออภัยครับ ไม่สามารถสร้างรูปภาพได้ในขณะนี้ อาจเป็นเพราะ:\n• Server ของ AI กำลัง busy\n• ข้อความอาจมีเนื้อหาไม่เหมาะสม\n• มีการใช้งานเกินขีดจำกัด\n\nกรุณาลองใหม่ในอีกสักครู่ครับ',
        });
      }
      return; // จบการทำงานสำหรับคำสั่งสร้างรูปภาพ
    } else {
      // ข้อความธรรมดา ให้ AI ตอบ
      aiResponse = await callGeminiAPI(userMessage);
    }
  } else if (event.message.type === 'image') {
    const imageBase64 = await getImageFromLine(event.message.id);
    if (imageBase64) {
      aiResponse = await callGeminiAPIWithImage(imageBase64);
    } else {
      aiResponse = 'ขออภัยค่ะ ไม่สามารถดาวน์โหลดรูปภาพได้';
    }
  } else {
    return; //fallback ไม่ให้ทำอะไรถ้าไม่ใช่ข้อความหรือรูปภาพ (กัน error แอปพัง)
  }

  // ตอบกลับข้อความหาผู้ใช้
  if (aiResponse) {
    await client.replyMessage(event.replyToken, {
      type: 'text',
      text: aiResponse,
    });
  }
}

// Route ทดสอบเซิร์ฟเวอร์
app.get('/', (req, res) => {
  res.send('Hello, this is Line Bot with Gemini AI (Kaemsai) on Vercel!');
});

module.exports = app;
