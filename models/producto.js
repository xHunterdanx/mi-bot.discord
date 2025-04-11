const mongoose = require('mongoose');

const productoSchema = new mongoose.Schema({
  catalogo: { type: String, required: true }, // Campo para identificar el catálogo (components, ships, money, etc.)
  nombre: { type: String, required: true },
  descripcion: { type: String, required: true },
  imagen: { type: String, required: true },
  precioUEC: { type: Number, required: true },
  precioUSD: { type: Number, required: true },
  enStock: { type: Boolean, required: true, default: false } // Nuevo campo para el estado "En stock"/"Agotado"
});

module.exports = mongoose.model('Producto', productoSchema);