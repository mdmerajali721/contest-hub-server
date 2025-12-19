const express = require("express");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
require("dotenv").config();
const app = express();
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const admin = require("firebase-admin");

const port = process.env.PORT || 5000;

app.use(express.json());
app.use(cors());

// const serviceAccount = require("./contesthubbd-fb-admin-key.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
const verifyFBToken = async (req, res, next) => {
  const token = req.headers?.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorize access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// Create a MongoClient
const client = new MongoClient(process.env.DB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    // await client.connect();

    const database = client.db("contesthubDB");
    const contestsCollection = database.collection("contests");
    const usersCollection = database.collection("users");
    const paymentsCollection = database.collection("payments");

    // middleware more with database access
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };

      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbidden access" });
      }

      next();
    };

    // get all user
    app.get("/users", async (req, res) => {
      try {
        const result = await usersCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    //   user role get
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;
        const query = { email };
        const result = await usersCollection.findOne(query);
        res.send({ role: result?.role || "user" });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // get one user
    app.get("/users/one", async (req, res) => {
      try {
        const email = req.query.email;
        const query = {};

        if (email) {
          query.email = email;
        }

        const result = await usersCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // update user info
    app.patch("/users/:id/info", async (req, res) => {
      try {
        const id = req.params.id;

        // const updatedInfo = req.body;    
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = { $set: req.body };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // updated win count
    app.patch("/users/win-count/:email", async (req, res) => {
      try {
        const email = req.params.email;

        const userResult = await usersCollection.findOne(
          { email },
          {
            projection: { winCount: 1 },
          }
        );
        
        const { winCount } = userResult;

        // Default 0 if undefined / null / ""
        const current = parseInt(winCount) || 0;
        const totalWinCount = current + 1;
        const result = await usersCollection.updateOne(
          { email },
          {
            $set: { winCount: totalWinCount },
          }
        );

        // const filter = { _id: new ObjectId(id) };
        // const updatedDoc = { set: req.body };
        // const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // update user role
    app.patch("/users/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const id = req.params.id;

        const filter = { _id: new ObjectId(id) };
        const updatedDoc = { $set: req.body };
        const result = await usersCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    //   user created
    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        user.role = "user";
        user.createdAt = new Date();
        user.status = "Active";

        const email = user.email;

        const existUser = await usersCollection.findOne({ email });
        if (existUser) {
          return res.send("User Already Exist");
        }
        const result = await usersCollection.insertOne(req.body);
        res.status(201).send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // PAYMENTS RELATED API'S
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.contestPrice) * 100;

      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo?.contestName,
                description: paymentInfo?.contestDescription,
                images: [paymentInfo?.contestImage],
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo?.participant?.email,
        mode: "payment",
        metadata: {
          contestId: paymentInfo.contestId,
          customer: paymentInfo.participant.email,
          deadline: paymentInfo.contestDeadline,
          name: paymentInfo?.contestName,
        },
        success_url: `${process.env.SITE_DOMAIN}/contest/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/contest/payment-cancelled`,
      });
      res.send({ url: session.url });
    });

    // post payment
    app.post("/payment-success", async (req, res) => {
      try {
        const { sessionId } = req.body;

        const session = await stripe.checkout.sessions.retrieve(sessionId);

        const transactionId = session.payment_intent;
        // const contestId = session.metadata.contestId;
        const query = { transactionId };

        const paymentExist = await paymentsCollection.findOne(query);
        if (paymentExist) {
          return res.send({
            message: "already exists",
            transactionId,
            amount: session.amount_total / 100,
            contestId: session.metadata.contestId,
          });
        }

        const payment = {
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          amount: session.amount_total / 100,
          currency: session.currency,
          contestParticipantEmail: session.customer_email,
          contestId: session.metadata.contestId,
          contestDeadline: session.metadata.deadline,
          contestName: session.metadata.name,
          submitted: null,
          paidAt: new Date(),
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentsCollection.insertOne(payment);
          res.send({
            success: true,
            paymentInfo: resultPayment,
            amount: session.amount_total / 100,
            transactionId: session.payment_intent,
            contestId: session.metadata.contestId,
          });
        }

        // participants added
        if (session.payment_status === "paid") {
          const contestId = session.metadata.contestId;
          const query = { _id: new ObjectId(contestId) };

          const participantsResult = await contestsCollection.findOne(query, {
            projection: { participants: 1 },
          });
          const { participants } = participantsResult;
          const current = parseInt(participants) || 0;
          const totalParticipants = current + 1;
          await contestsCollection.updateOne(query, {
            $set: { participants: totalParticipants },
          });
        }
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // payment status
    app.get("/payments/payment-status", async (req, res) => {
      try {
        const { contestId, contestParticipantEmail } = req.query;
        const query = { contestId, contestParticipantEmail };
        const result = await paymentsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // participated contests
    app.get("/payments/all-contests", async (req, res) => {
      try {
        const contestParticipantEmail = req.query.contestParticipantEmail;
        const query = { contestParticipantEmail };
        // if (contestParticipantEmail) {
        //   query.contestParticipantEmail = contestParticipantEmail;
        // }
        const sortFields = { contestDeadline: 1 };

        const result = await paymentsCollection
          .find(query)
          .sort(sortFields)
          .toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // payments task-submitted
    app.get("/payments/task-submitted", async (req, res) => {
      try {
        const { contestId } = req.query;
        const submitted = true;

        const query = { contestId, submitted };
        const result = await paymentsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // submitted true and task submitted
    app.patch("/payments/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const { contestParticipantEmail } = req.query;
        const filter = { _id: new ObjectId(id), contestParticipantEmail };

        const updatedDoc = {
          $set: req.body,
        };
        const result = await paymentsCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    
    // get all by admin
    app.get("/contests", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const result = await contestsCollection.find().toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // /contests/all-users/search
    app.get("/contests/all-users/search", async (req, res) => {
      try {
        const { searchText } = req.query;

        let query = {
          status: "Confirmed",
        };

        if (searchText) {
          query.$or = [
            { name: { $regex: searchText, $options: "i" } },

            { type: { $regex: searchText, $options: "i" } },
          ];
        }

        const result = await contestsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // get all contests by creator email
    app.get("/contests/creator", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        const query = {};
        if (!email) {
          return res.send({ message: "creator email not found" });
        } else {
          query.email = email;
        }

        const result = await contestsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // get all contest for all users
    app.get("/contests/all-users", async (req, res) => {
      try {
        const status = req.query.status;
        const query = {};

        if (status) {
          query.status = status;
        }

        const result = await contestsCollection.find(query).toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // get popular contests
    app.get("/contests/popular-contests", async (req, res) => {
      try {
        const status = req.query.status;
        const sortFields = { participants: -1 };
        const limitNum = 6;
        const result = await contestsCollection
          .find({ status })
          .sort(sortFields)
          .limit(limitNum)
          .toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });
    // get one contest
    app.get("/contests/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await contestsCollection.findOne(query);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // contests winner get by winner email
    app.get("/contests/winner/contests", verifyFBToken, async (req, res) => {
      try {
        const email = req.query.email;
        // const query = {}
        // if (email) {
        //   query.winner.email: email
        // }

        const result = await contestsCollection
          .find({ "winner.email": email })
          .toArray();
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // created contest
    app.post("/contests", verifyFBToken, async (req, res) => {
      try {
        const contest = req.body;
        contest.status = "Pending";
        contest.createdAt = new Date();
        const result = await contestsCollection.insertOne(contest);
        res.status(201).send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // update contest role for admin
    app.patch(
      "/contests/:id/admin",

      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const status = req.body.newStatus;

          const id = req.params.id;
          const filter = { _id: new ObjectId(id) };
          const updatedDoc = { $set: { status } };
          const result = await contestsCollection.updateOne(filter, updatedDoc);
          res.send(result);
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Server Error" });
        }
      }
    );

    // contest winner updated by creator
    app.patch("/contests/:id/creator", verifyFBToken, async (req, res) => {
      try {
        const win = req.body;
        const id = req.params.id;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            winner: win,
          },
        };
        const result = await contestsCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // update contest for creator
    app.patch("/contests/:id/update", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;

        const contest = req.body;

        const contestInfo = {
          deadline: contest.deadline,
          description: contest.description,
          image: contest.image,
          instructions: contest.instructions,
          name: contest.name,
          price: contest.price,
          prizeMoney: contest.prizeMoney,
          type: contest.type,
        };

        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: contestInfo,
        };
        const result = await contestsCollection.updateOne(filter, updatedDoc);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });

    // deleted contest by admin
    app.delete(
      "/contests/:id",

      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;
          const query = { _id: new ObjectId(id) };
          const result = await contestsCollection.deleteOne(query);
          res.send(result);
        } catch (error) {
          console.error(error);
          res.status(500).send({ message: "Server Error" });
        }
      }
    );
    // deleted contest by creator
    app.delete("/contests/creator/:id", verifyFBToken, async (req, res) => {
      try {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await contestsCollection.deleteOne(query);
        res.send(result);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server Error" });
      }
    });
    // await client.db("admin").command({ ping: 1 });
  } finally {
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Contest Hub Server is Running");
});

app.listen(port, () => {
  console.log(`ContestHub server running on http://localhost:${port}`);
});
