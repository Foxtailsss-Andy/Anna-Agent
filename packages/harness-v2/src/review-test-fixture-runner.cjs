"use strict";

if (process.env.ANNA_T07_FIXTURE_NO_NETWORK === "1") {
  const { syncBuiltinESMExports } = require("node:module");
  const net = require("node:net");
  const tls = require("node:tls");

  const networkDenied = () => {
    const error = new Error("T07 fixture process network is denied");
    error.code = "ERR_T07_NETWORK_DENIED";
    return error;
  };
  const rejectFetch = () => Promise.reject(networkDenied());
  const rejectConnection = () => {
    const socket = new net.Socket();
    queueMicrotask(() => socket.emit("error", networkDenied()));
    return socket;
  };

  globalThis.fetch = rejectFetch;
  net.connect = rejectConnection;
  net.createConnection = rejectConnection;
  tls.connect = rejectConnection;
  syncBuiltinESMExports();
}
