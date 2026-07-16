import http from "node:http";

const request = http.get(
  {
    host: "127.0.0.1",
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    path: "/healthz",
    timeout: 3000,
  },
  (response) => {
    response.resume();
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);

request.on("timeout", () => request.destroy(new Error("health check timed out")));
request.on("error", () => process.exit(1));
