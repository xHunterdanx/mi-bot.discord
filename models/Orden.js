const mongoose = require('mongoose');

const ordenSchema = new mongoose.Schema({
  usuarioId: String,
  producto: String,
  cantidad: Number,
  metodoPago: String,
  fecha: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Orden', ordenSchema);