const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
function getFirebaseAdmin() {
  let app;

  if (getApps().length === 0) {
    const encodedKey = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

    if (!encodedKey) {
      throw new Error("Firebase service account is not configured.");
    }

    const serviceAccount = JSON.parse(
      Buffer.from(encodedKey, "base64").toString("utf8")
    );

    app = initializeApp({
      credential: cert(serviceAccount)
    });
  } else {
    app = getApps()[0];
  }

  return {
    auth: getAuth(app),
    db: getFirestore(app),
    FieldValue: FieldValue
  };
}



  
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ message: "Method not allowed." })
    };
  }

 let newUser;
let auth;
let db;
let studentRef;
const registrationToken = crypto.randomUUID();

  try {
    const { studentId, email, password } = JSON.parse(event.body || "{}");

    if (
      typeof studentId !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Please provide all registration details."
        })
      };
    }

    const cleanId = studentId.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (!cleanId || !cleanEmail || password.length < 8) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          message: "Enter a valid student ID, email, and password of at least 8 characters."
        })
      };
    }

    const firebase = getFirebaseAdmin();
   db = firebase.db;
    auth = firebase.auth;

   studentRef = db.collection("students").doc(cleanId);
let student;

const reservationResult = await db.runTransaction(async (transaction) => {
  const studentDoc = await transaction.get(studentRef);

  if (!studentDoc.exists) {
    return { statusCode: 403, message: "Registration is not authorized." };
  }

  const studentData = studentDoc.data();

  if (
    studentData.approved !== true ||
    String(studentData.email || "").trim().toLowerCase() !== cleanEmail
  ) {
    return { statusCode: 403, message: "Registration is not authorized." };
  }

  if (studentData.uid) {
    return { statusCode: 409, message: "This student account is already registered." };
  }

  const now = Date.now();

  if (
    studentData.registrationToken &&
    now - studentData.registrationStartedAt < 10 * 60 * 1000
  ) {
    return { statusCode: 409, message: "Registration is already in progress." };
  }

  student = studentData;

  transaction.update(studentRef, {
    registrationToken: registrationToken,
    registrationStartedAt: now
  });

  return { statusCode: 200 };
});

if (reservationResult.statusCode !== 200) {
  return {
    statusCode: reservationResult.statusCode,
    body: JSON.stringify({
      message: reservationResult.message
    })
  };
}

    newUser = await auth.createUser({
      email: cleanEmail,
      password: password,
      displayName: student.name || cleanId
    });

    await auth.setCustomUserClaims(newUser.uid, {
      role: "student",
      studentId: cleanId
    });

await db.runTransaction(async (transaction) => {
  const currentDoc = await transaction.get(studentRef);

  if (
    !currentDoc.exists ||
    currentDoc.data().registrationToken !== registrationToken
  ) {
    throw new Error("Registration reservation expired or changed.");
  }

  transaction.update(studentRef, {
    uid: newUser.uid,
    registeredAt: firebase.FieldValue.serverTimestamp(),
    registrationToken: firebase.FieldValue.delete(),
    registrationStartedAt: firebase.FieldValue.delete()
  });
});

    // Send account confirmation email
    try {
      if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        const transporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          }
        });

        await transporter.sendMail({
          from: `"Africa University E-Portfolio" <${process.env.SMTP_USER}>`,
          to: cleanEmail,
          subject: "Your Student E-Portfolio Account Has Been Created",
          text: `
Hello ${student.name || cleanId},

Your Africa University Student E-Portfolio account has been created successfully.

Your account information:

Full Name: ${student.name || cleanId}
Student ID: ${cleanId}
Email Address: ${cleanEmail}

You can now log in and access your student portfolio.

Login here:
https://africa-university-eportfolio.netlify.app

Thank you,
Africa University Student E-Portfolio
          `
        });
      }
    } catch (emailError) {
      console.error("Confirmation email failed:", emailError);
    }
    return {
      statusCode: 201,
      body: JSON.stringify({
        message: "Registration successful. You can now log in."
      })
    };

  } catch (error) {
    console.error("Registration error:", error);

    if (newUser && auth) {
  try {
    await auth.deleteUser(newUser.uid);
  } catch (cleanupError) {
    console.error("Account cleanup error:", cleanupError);
  }
}

if (db) {
  try {
    await db.runTransaction(async (transaction) => {
      if (!studentRef) return;
      const studentDoc = await transaction.get(studentRef);

      if (
        studentDoc.exists &&
        studentDoc.data().registrationToken === registrationToken
      ) {
        transaction.update(studentRef, {
          registrationToken: FieldValue.delete(),
          registrationStartedAt: FieldValue.delete()
        });
      }
    });
  } catch (reservationError) {
    console.error("Reservation cleanup error:", reservationError);
  }
}

    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Registration could not be completed. Please try again."
      })
    };
  }
};
