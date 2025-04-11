const mongoose = require('mongoose');

const ventaSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  items: [{
    productName: { type: String, required: true },
    quantity: { type: Number, required: true },
    precioUEC: { type: Number, required: true },
    precioUSD: { type: Number, required: true }
  }],
  totalUEC: { type: Number, required: true },
  totalUSD: { type: Number, required: true },
  timestamp: { type: Date, default: Date.now },
  status: { type: String, enum: ['Delivered', 'Partially Delivered'], required: true }
});

module.exports = mongoose.model('Venta', ventaSchema);