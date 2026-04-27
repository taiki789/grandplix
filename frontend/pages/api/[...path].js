const backendApp = require("../../../backend/server");

export const config = {
  maxDuration: 300,
  api: {
    bodyParser: false,
    responseLimit: false,
    externalResolver: true
  }
};

export default function handler(req, res) {
  const rewritten = req.url.replace(/^\/api(?=\/|$)/, "") || "/";
  req.url = rewritten;
  return backendApp(req, res);
}
