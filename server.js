const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Servir la carpeta "public"
app.use(express.static(path.join(__dirname, "public")));

let players = {}; // { socketId: { x, y, id } }

// Cuando un cliente se conecta
io.on("connection", (socket) => {
  console.log("Nuevo jugador conectado:", socket.id);

  // Posición inicial del nuevo jugador
  players[socket.id] = {
    id: socket.id,
    x: 180,
    y: 450,
  };

  // Enviar al nuevo jugador el estado actual de todos
  socket.emit("currentPlayers", players);

  // Avisar a los demás que llegó un nuevo jugador
  socket.broadcast.emit("newPlayer", players[socket.id]);

  // Cuando este jugador mueve su gallina
  socket.on("playerMove", (data) => {
    if (players[socket.id]) {
      players[socket.id].x = data.x;
      players[socket.id].y = data.y;
      // Avisar a todos la nueva posición
      io.emit("playerMoved", {
        id: socket.id,
        x: data.x,
        y: data.y,
      });
    }
  });

  // Cuando se desconecta
  socket.on("disconnect", () => {
    console.log("Jugador desconectado:", socket.id);
    delete players[socket.id];
    // Avisar a los demás que se fue
    io.emit("playerDisconnected", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});