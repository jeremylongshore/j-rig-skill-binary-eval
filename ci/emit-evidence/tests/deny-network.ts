/** Child-process interoperability guard: offline signing must not open a network connection. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
const deny = () => {
  throw new Error("network access forbidden in offline producer fixture");
};
http.request = deny;
http.get = deny;
https.request = deny;
https.get = deny;
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
globalThis.fetch = deny;
