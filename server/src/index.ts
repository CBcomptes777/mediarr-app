import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 8080);
const app = buildServer(process.env);

app.listen({ port, host: "0.0.0.0" }).then(() => {
  console.log(`Mediarr à l'écoute sur le port ${port}`);
});
