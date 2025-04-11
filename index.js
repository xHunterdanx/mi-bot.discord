require('./models/producto');
require('./models/venta');
const Orden = require('./models/Orden');
const XLSX = require('xlsx');

const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, Events, MessageFlags } = require('discord.js');
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ]
});

client.once('ready', () => {
  console.log(`Bot connected as ${client.user.tag}`);
  updateSalesEmbed();
  setInterval(updateSalesEmbed, 5 * 60 * 60 * 1000); // 5 hours in milliseconds
});

client.login(process.env.DISCORD_TOKEN);

const carritos = new Map();
const ephemeralMessages = new Map();
const listaEspera = new Map();
const pedidosPendientes = new Map();
const estadosConfirmacion = new Map();
const estadosPublicacion = new Map();
let salesEmbedMessageId = null;

// Map of catalog IDs to their human-readable names
const catalogoNombres = {
  'catalogo1': '(Reserved for future use)', // Dejamos catalogo1 vacío para el futuro
  'catalogo2': 'Ships', // Renombrado de catalogo1 a catalogo2
  'catalogo3': 'Money',
  'catalogo4': 'Weapons Hard Point',
  'catalogo5': 'Paintjobs',
  'catalogo6': 'Resources',
  'catalogo7': 'Gear',
  'catalogo8': 'PowerPlants',
  'catalogo9': 'Quantum Drive',
  'catalogo10': 'Coolers',
  'catalogo11': 'Shields'
};

const canalesCatalogos = {
  'catalogo1': '', // Dejamos vacío para el futuro
  'catalogo2': '1358353542599016478', // Antes era catalogo1, ahora es catalogo2 (Ships)
  'catalogo3': '1358371748826841159',
  'catalogo4': '1358353660152643769',
  'catalogo5': '1358353721498665032',
  'catalogo6': '1358353787512946725',
  'catalogo7': '1358353828864594050',
  'catalogo8': '1360199607619158056', // PowerPlants
  'catalogo9': '1360199752150421576', // Quantum Drive
  'catalogo10': '1360199830986559489', // Coolers
  'catalogo11': '1360200069768417280' // Shields
};

const Producto = require('./models/producto');
const Venta = require('./models/venta');
const estadosFormulario = new Map();

// Helper function to format numbers with "k" or "M" for UEC
function formatUEC(value) {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  } else if (value >= 1000) {
    return `${(value / 1000).toFixed(0)}k`;
  }
  return value.toString();
}

// Helper function to format USD (integer if .00, otherwise up to 2 decimals)
function formatUSD(value) {
  const rounded = Number(value.toFixed(2));
  return rounded % 1 === 0 ? rounded.toString() : rounded.toFixed(2);
}

// Helper function to create or update the sales embed
async function updateSalesEmbed() {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  sixMonthsAgo.setHours(0, 0, 0, 0);

  const ventas = await Venta.find({ timestamp: { $gte: sixMonthsAgo } });

  const monthlySales = {};
  for (let i = 0; i < 6; i++) {
    const date = new Date();
    date.setMonth(date.getMonth() - i);
    const monthYear = date.toLocaleString('default', { month: 'long', year: 'numeric' });
    monthlySales[monthYear] = { totalUEC: 0, totalUSD: 0 };
  }

  let totalSalesUEC = 0;
  let totalSalesUSD = 0;

  ventas.forEach(venta => {
    const saleMonthYear = venta.timestamp.toLocaleString('default', { month: 'long', year: 'numeric' });
    if (monthlySales[saleMonthYear]) {
      monthlySales[saleMonthYear].totalUEC += venta.totalUEC;
      monthlySales[saleMonthYear].totalUSD += venta.totalUSD;
    }
    totalSalesUEC += venta.totalUEC;
    totalSalesUSD += venta.totalUSD;
  });

  const embed = new EmbedBuilder()
    .setTitle('📊 Sales Summary (Last 6 Months)')
    .setColor(0x00AE86)
    .setTimestamp();

  let monthlyDescription = '';
  for (const [monthYear, totals] of Object.entries(monthlySales)) {
    monthlyDescription += `**${monthYear}**: ${formatUEC(totals.totalUEC)} UEC / $${formatUSD(totals.totalUSD)}\n`;
  }

  embed.setDescription(monthlyDescription);
  embed.addFields({
    name: 'Total Sales (Last 6 Months)',
    value: `${formatUEC(totalSalesUEC)} UEC / $${formatUSD(totalSalesUSD)}`,
    inline: false
  });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('update_sales')
      .setLabel('🔄 Update Now')
      .setStyle(ButtonStyle.Primary)
  );

  const financeChannel = await client.channels.fetch('1360120519999099022');
  if (!financeChannel || !financeChannel.isTextBased()) {
    console.error('Could not find or access the finance channel (1360120519999099022).');
    return;
  }

  try {
    if (salesEmbedMessageId) {
      const message = await financeChannel.messages.fetch(salesEmbedMessageId).catch(() => null);
      if (message) {
        await message.edit({ embeds: [embed], components: [row] });
      } else {
        const newMessage = await financeChannel.send({ embeds: [embed], components: [row] });
        salesEmbedMessageId = newMessage.id;
      }
    } else {
      const messages = await financeChannel.messages.fetch({ limit: 100 });
      const existingEmbed = messages.find(msg => msg.author.id === client.user.id && msg.embeds.length > 0 && msg.embeds[0].title === '📊 Sales Summary (Last 6 Months)');
      if (existingEmbed) {
        await existingEmbed.edit({ embeds: [embed], components: [row] });
        salesEmbedMessageId = existingEmbed.id;
      } else {
        const newMessage = await financeChannel.send({ embeds: [embed], components: [row] });
        salesEmbedMessageId = newMessage.id;
      }
    }
  } catch (err) {
    console.error('Error updating sales embed:', err);
  }
}

// Helper function to calculate and publish sales
async function publishSalesSummary(userId, deliveredItems, status, currency) {
  const totalUEC = currency === 'UEC' ? deliveredItems.reduce((sum, item) => sum + (item.producto.precioUEC * item.cantidad), 0) : 0;
  const totalUSD = currency === 'USD' ? deliveredItems.reduce((sum, item) => sum + (item.producto.precioUSD * item.cantidad), 0) : 0;

  const venta = new Venta({
    userId,
    items: deliveredItems.map(item => ({
      productName: item.producto.nombre,
      quantity: item.cantidad,
      precioUEC: item.producto.precioUEC,
      precioUSD: item.producto.precioUSD,
      currencyUsed: currency
    })),
    totalUEC,
    totalUSD,
    status
  });
  await venta.save();

  await updateSalesEmbed();
}

// Helper function to publish products in a specific catalog
async function publishProducts(catalogo) {
  const productos = await Producto.find({ catalogo });
  if (productos.length === 0) {
    return `❌ No products found in **${catalogoNombres[catalogo]}** to publish.`;
  }

  const canal = await client.channels.fetch(canalesCatalogos[catalogo]);
  if (!canal || !canal.isTextBased()) {
    return `❌ Could not find the associated channel for **${catalogoNombres[catalogo]}**.`;
  }

  console.log(`📦 Updating ${productos.length} products in ${catalogoNombres[catalogo]}`);

  // Obtener los mensajes existentes en el canal
  const messages = await canal.messages.fetch({ limit: 100 });
  const existingMessages = new Map();
  messages.forEach(msg => {
    if (msg.author.id === client.user.id && msg.embeds.length > 0) {
      const productName = msg.embeds[0].title;
      existingMessages.set(productName, msg);
    }
  });

  let updatedCount = 0;
  let newCount = 0;

  for (let producto of productos) {
    const embed = new EmbedBuilder()
      .setTitle(producto.nombre)
      .setDescription(producto.descripcion)
      .addFields(
        { name: 'Price in UEC', value: producto.precioUEC === 0 ? 'Not available' : formatUEC(producto.precioUEC) + ' UEC', inline: true },
        { name: 'Price in USD', value: producto.precioUSD === 0 ? 'Not available' : '$' + formatUSD(producto.precioUSD), inline: true },
        { name: 'Status', value: producto.enStock ? 'In Stock ✅' : 'Out of Stock ❌', inline: true }
      )
      .setColor(0x00AE86);

    if (producto.imagen && producto.imagen.startsWith('http')) {
      embed.setImage(producto.imagen);
    }

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`agregar_${producto.nombre}_temp`)
        .setLabel('➕ Add to Cart')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!producto.enStock),
      new ButtonBuilder()
        .setCustomId(`solicitar_${producto.nombre}_temp`)
        .setLabel('📋 Request Product')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(producto.enStock),
      new ButtonBuilder()
        .setCustomId(`checkout_uec_${producto.nombre}_temp`)
        .setLabel('💰 Buy with UEC')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!producto.enStock || producto.precioUEC === 0),
      new ButtonBuilder()
        .setCustomId(`checkout_usd_${producto.nombre}_temp`)
        .setLabel('💵 Buy with USD')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!producto.enStock || producto.precioUSD === 0)
    );

    const existingMessage = existingMessages.get(producto.nombre);

    if (existingMessage) {
      // Editar el mensaje existente
      const updatedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`agregar_${producto.nombre}_${existingMessage.id}`)
          .setLabel('➕ Add to Cart')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!producto.enStock),
        new ButtonBuilder()
          .setCustomId(`solicitar_${producto.nombre}_${existingMessage.id}`)
          .setLabel('📋 Request Product')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(producto.enStock),
        new ButtonBuilder()
          .setCustomId(`checkout_uec_${producto.nombre}_${existingMessage.id}`)
          .setLabel('💰 Buy with UEC')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!producto.enStock || producto.precioUEC === 0),
        new ButtonBuilder()
          .setCustomId(`checkout_usd_${producto.nombre}_${existingMessage.id}`)
          .setLabel('💵 Buy with USD')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!producto.enStock || producto.precioUSD === 0)
      );

      await existingMessage.edit({ embeds: [embed], components: [updatedRow] });
      updatedCount++;
    } else {
      // Publicar un nuevo mensaje si el producto no tiene un mensaje existente
      const sentMessage = await canal.send({ embeds: [embed], components: [row] });

      const updatedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`agregar_${producto.nombre}_${sentMessage.id}`)
          .setLabel('➕ Add to Cart')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!producto.enStock),
        new ButtonBuilder()
          .setCustomId(`solicitar_${producto.nombre}_${sentMessage.id}`)
          .setLabel('📋 Request Product')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(producto.enStock),
        new ButtonBuilder()
          .setCustomId(`checkout_uec_${producto.nombre}_${sentMessage.id}`)
          .setLabel('💰 Buy with UEC')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!producto.enStock || producto.precioUEC === 0),
        new ButtonBuilder()
          .setCustomId(`checkout_usd_${producto.nombre}_${sentMessage.id}`)
          .setLabel('💵 Buy with USD')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!producto.enStock || producto.precioUSD === 0)
      );

      await sentMessage.edit({ components: [updatedRow] });
      newCount++;
    }
  }

  return `✅ Catalog **${catalogoNombres[catalogo]}** updated: ${updatedCount} products updated, ${newCount} new products published.`;
}

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;
  const esAdmin = message.member.permissions.has('Administrator');

  // Command: !borrarProductos
  if (message.content.startsWith('!borrarProductos')) {
    if (!esAdmin) {
      return message.reply('❌ Only administrators can delete all products.');
    }

    try {
      const deletedCount = await Producto.deleteMany({});
      return message.reply(`🗑️ Successfully deleted ${deletedCount.deletedCount} products from the database.`);
    } catch (err) {
      console.error(err);
      return message.reply('❌ Error deleting products from the database.');
    }
  }

  // Command: !subirExcel [publicar]
  if (message.content.startsWith('!subirExcel')) {
    if (!esAdmin) {
      return message.reply('❌ Only administrators can upload Excel files.');
    }

    if (message.attachments.size === 0) {
      return message.reply('❌ You must attach an Excel file (.xlsx). Example: Upload a file and write `!subirExcel` or `!subirExcel publicar` in the message.');
    }

    const attachment = message.attachments.first();
    if (!attachment.name.endsWith('.xlsx')) {
      return message.reply('❌ The file must be an Excel file (.xlsx).');
    }

    const autoPublish = message.content.includes('publicar');

    try {
      const response = await fetch(attachment.url);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      if (jsonData.length === 0) {
        return message.reply('❌ The Excel file is empty.');
      }

      const requiredColumns = ['catalogo', 'nombre', 'descripcion', 'imagen', 'precioUEC', 'precioUSD', 'enStock'];
      const missingColumns = requiredColumns.filter(col => !Object.keys(jsonData[0]).includes(col));
      if (missingColumns.length > 0) {
        return message.reply(`❌ The Excel file is missing the following required columns: ${missingColumns.join(', ')}.`);
      }

      let productosAgregados = 0;
      let errores = [];
      const catalogosAfectados = new Set();

      for (const row of jsonData) {
        const catalogo = row['catalogo']?.toString().trim();
        const nombre = row['nombre']?.toString().trim();
        const descripcion = row['descripcion']?.toString().trim();
        const imagen = row['imagen']?.toString().trim();
        const precioUEC = parseInt(row['precioUEC']) || 0; // Tratar vacío como 0
        const precioUSD = parseFloat(row['precioUSD']) || 0; // Tratar vacío como 0
        const enStockRaw = row['enStock']?.toString().trim();
        const enStock = enStockRaw && (enStockRaw.toLowerCase() === 'sí' || enStockRaw.toLowerCase() === 'si' || enStockRaw.toLowerCase() === 'true' || enStockRaw.toLowerCase() === 'yes' || enStockRaw === '1');

        // Ignorar filas con datos incompletos
        if (!catalogo || !nombre || !descripcion || !imagen || enStockRaw === undefined) {
          continue; // Saltar esta fila sin generar un error
        }

        if (!canalesCatalogos[catalogo] || canalesCatalogos[catalogo] === '') {
          errores.push(`Row ${jsonData.indexOf(row) + 2}: Invalid catalog (${catalogo}). Use: ${Object.values(catalogoNombres).filter(name => name !== '(Reserved for future use)').join(', ')}`);
          continue;
        }
        if (!imagen.startsWith('http')) {
          errores.push(`Row ${jsonData.indexOf(row) + 2}: Invalid image URL (${imagen}).`);
          continue;
        }

        const productoExistente = await Producto.findOne({ nombre, catalogo });
        if (productoExistente) {
          productoExistente.descripcion = descripcion;
          productoExistente.imagen = imagen;
          productoExistente.precioUEC = precioUEC;
          productoExistente.precioUSD = precioUSD;
          productoExistente.enStock = enStock;
          await productoExistente.save();
        } else {
          const nuevoProducto = new Producto({
            catalogo,
            nombre,
            descripcion,
            imagen,
            precioUEC,
            precioUSD,
            enStock
          });
          await nuevoProducto.save();
        }
        productosAgregados++;
        catalogosAfectados.add(catalogo);
      }

      let respuesta = `✅ Successfully added/updated ${productosAgregados} products.\n`;
      if (errores.length > 0) {
        const maxErroresAMostrar = 10; // Mostrar solo los primeros 10 errores
        const erroresAMostrar = errores.slice(0, maxErroresAMostrar);
        respuesta += `⚠️ Found ${errores.length} errors:\n${erroresAMostrar.join('\n')}\n`;
        if (errores.length > maxErroresAMostrar) {
          respuesta += `...and ${errores.length - maxErroresAMostrar} more errors. Please check your Excel file for details.\n`;
        }
      }
      const catalogosAfectadosNombres = [...catalogosAfectados].map(catalogo => catalogoNombres[catalogo]).join(', ');
      respuesta += `Affected catalogs: ${catalogosAfectadosNombres || '(none)'}.`;

      if (autoPublish && catalogosAfectados.size > 0) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirmarPublicacion_${message.author.id}`)
            .setLabel('Yes, Publish Now')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`cancelarPublicacion_${message.author.id}`)
            .setLabel('No, Publish Later')
            .setStyle(ButtonStyle.Danger)
        );

        estadosPublicacion.set(message.author.id, {
          catalogos: [...catalogosAfectados],
          messageId: message.id
        });

        return message.reply({
          content: `${respuesta}\n\n📢 Do you want to publish the updated products in the corresponding channels now?`,
          components: [row]
        });
      }

      return message.reply(respuesta);
    } catch (err) {
      console.error(err);
      return message.reply('❌ Error processing the Excel file. Ensure the format is correct.');
    }
  }

  // Command: !publicarProductos
  if (message.content.startsWith('!publicarProductos')) {
    if (!esAdmin) {
      return message.reply('❌ Only administrators can publish products.');
    }

    const catalogoInput = message.content.replace('!publicarProductos', '').trim();
    let catalogo;
    if (canalesCatalogos[catalogoInput]) {
      catalogo = catalogoInput;
    } else {
      const catalogoNameLower = catalogoInput.toLowerCase();
      catalogo = Object.keys(catalogoNombres).find(key => catalogoNombres[key].toLowerCase() === catalogoNameLower);
    }

    if (!catalogo || canalesCatalogos[catalogo] === '') {
      return message.reply(`❌ Invalid catalog. Use: ${Object.values(catalogoNombres).filter(name => name !== '(Reserved for future use)').join(', ')}`);
    }

    const result = await publishProducts(catalogo);
    return message.reply(result);
  }

  // Command: !nuevo
  if (message.content.startsWith('!nuevo')) {
    const partes = message.content.split(' ');
    let catalogoInput = partes[1];
    let catalogo;

    if (!catalogoInput) {
      return message.reply(`❌ You must specify a valid catalog. Example: \`!nuevo Ships\`\nAvailable catalogs: ${Object.values(catalogoNombres).filter(name => name !== '(Reserved for future use)').join(', ')}`);
    }

    if (canalesCatalogos[catalogoInput]) {
      catalogo = catalogoInput;
    } else {
      const catalogoNameLower = catalogoInput.toLowerCase();
      catalogo = Object.keys(catalogoNombres).find(key => catalogoNombres[key].toLowerCase() === catalogoNameLower);
    }

    if (!catalogo || canalesCatalogos[catalogo] === '') {
      return message.reply(`❌ Invalid catalog. Use: ${Object.values(catalogoNombres).filter(name => name !== '(Reserved for future use)').join(', ')}`);
    }

    estadosFormulario.set(message.author.id, {
      paso: 'nombre',
      datos: { catalogo }
    });

    return message.reply('📝 Enter the **name** of the product:');
  }

  // Command: !actualizarEstado
  if (message.content.startsWith('!actualizarEstado')) {
    if (!esAdmin) {
      return message.reply('❌ Only administrators can update product status.');
    }

    const partes = message.content.split(' ');
    if (partes.length < 3) {
      return message.reply('❌ Usage: `!actualizarEstado <productName> <status>`\nExample: `!actualizarEstado Quantum Drive XL1 Yes`');
    }

    const nombreProducto = partes.slice(1, -1).join(' ').trim();
    const estado = partes[partes.length - 1].toLowerCase();
    const enStock = estado === 'yes' || estado === 'true' || estado === '1';

    try {
      const producto = await Producto.findOne({ nombre: nombreProducto });
      if (!producto) {
        return message.reply(`❌ No product found with the name **${nombreProducto}**.`);
      }

      const estadoAnterior = producto.enStock;
      producto.enStock = enStock;
      await producto.save();

      const canal = await client.channels.fetch(canalesCatalogos[producto.catalogo]);
      if (canal && canal.isTextBased()) {
        const messages = await canal.messages.fetch({ limit: 100 });
        const productoMessage = messages.find(msg => 
          msg.embeds[0]?.title === producto.nombre && msg.author.id === client.user.id
        );

        if (productoMessage) {
          const embed = EmbedBuilder.from(productoMessage.embeds[0])
            .spliceFields(2, 1)
            .addFields({ name: 'Status', value: producto.enStock ? 'In Stock ✅' : 'Out of Stock ❌', inline: true });

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`agregar_${producto.nombre}_${productoMessage.id}`)
              .setLabel('➕ Add to Cart')
              .setStyle(ButtonStyle.Primary)
              .setDisabled(!producto.enStock),
            new ButtonBuilder()
              .setCustomId(`solicitar_${producto.nombre}_${productoMessage.id}`)
              .setLabel('📋 Request Product')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(producto.enStock),
            new ButtonBuilder()
              .setCustomId(`checkout_uec_${producto.nombre}_${productoMessage.id}`)
              .setLabel('💰 Buy with UEC')
              .setStyle(ButtonStyle.Success)
              .setDisabled(!producto.enStock || producto.precioUEC === 0),
            new ButtonBuilder()
              .setCustomId(`checkout_usd_${producto.nombre}_${productoMessage.id}`)
              .setLabel('💵 Buy with USD')
              .setStyle(ButtonStyle.Success)
              .setDisabled(!producto.enStock || producto.precioUSD === 0)
          );

          await productoMessage.edit({ embeds: [embed], components: [row] });
        }
      }

      if (!estadoAnterior && enStock) {
        const usuariosEnEspera = listaEspera.get(producto.nombre) || [];
        for (const userId of usuariosEnEspera) {
          try {
            const user = await client.users.fetch(userId);
            await user.send(`📦 Great news, <@${userId}>! The product **${producto.nombre}** you requested is now in stock. You can purchase it in the channel <#${canalesCatalogos[producto.catalogo]}>.`);
          } catch (err) {
            console.error(`Could not notify user ${userId}:`, err);
          }
        }
        listaEspera.delete(producto.nombre);
      }

      message.reply(`✅ Status of **${nombreProducto}** updated to **${enStock ? 'In Stock' : 'Out of Stock'}**.`);
    } catch (err) {
      console.error(err);
      message.reply('❌ Error updating the product status.');
    }
    return;
  }

  // Handling the form for !nuevo
  const estadoFormulario = estadosFormulario.get(message.author.id);
  if (!estadoFormulario) return;

  const { paso, datos } = estadoFormulario;

  if (paso === 'nombre') {
    datos.nombre = message.content;
    estadosFormulario.set(message.author.id, { paso: 'descripcion', datos });
    return message.reply('📝 Enter the **description** of the product:');
  }

  if (paso === 'descripcion') {
    datos.descripcion = message.content;
    estadosFormulario.set(message.author.id, { paso: 'imagen', datos });
    return message.reply('🖼️ Provide the **image URL** of the product:');
  }

  if (paso === 'imagen') {
    datos.imagen = message.content;
    estadosFormulario.set(message.author.id, { paso: 'uec', datos });
    return message.reply('💰 What is the **price in UEC**? (Enter 0 if not available in UEC)');
  }

  if (paso === 'uec') {
    const valor = parseInt(message.content.replace(/[^0-9]/g, '')) || 0;
    datos.precioUEC = valor;
    estadosFormulario.set(message.author.id, { paso: 'usd', datos });
    return message.reply('💵 What is the **price in USD**? (Enter 0 if not available in USD)');
  }

  if (paso === 'usd') {
    const valor = parseFloat(message.content.replace(/[^0-9.]/g, '')) || 0;
    datos.precioUSD = valor;
    estadosFormulario.set(message.author.id, { paso: 'enStock', datos });
    return message.reply('📦 Is the product in stock? Reply "yes" for In Stock or "no" for Out of Stock:');
  }

  if (paso === 'enStock') {
    const respuesta = message.content.toLowerCase();
    const enStock = respuesta === 'yes' || respuesta === 'true' || respuesta === '1';
    datos.enStock = enStock;

    try {
      const nuevo = new Producto(datos);
      await nuevo.save();
      message.reply(`✅ Product **${datos.nombre}** successfully saved in **${catalogoNombres[datos.catalogo]}** with status **${enStock ? 'In Stock' : 'Out of Stock'}**.`);
    } catch (e) {
      console.error(e);
      message.reply('❌ Error saving the product.');
    }

    estadosFormulario.delete(message.author.id);
  }

  // Handling partial delivery confirmation
  const estadoConfirmacion = estadosConfirmacion.get(message.author.id);
  if (estadoConfirmacion) {
    const { pedidoMessage, items, entregados } = estadoConfirmacion;
    const respuesta = message.content.toLowerCase();
    const entregado = respuesta === 'yes' || respuesta === 'true' || respuesta === '1';

    const productoActual = items[entregados.length];
    if (entregado) {
      entregados.push(productoActual.producto.nombre);
    }

    if (entregados.length < items.length) {
      estadosConfirmacion.set(message.author.id, { pedidoMessage, items, entregados });
      return message.reply({
        content: `📦 Was **${items[entregados.length].producto.nombre}** delivered? Reply "yes" to confirm or "no" to skip:`,
        flags: MessageFlags.Ephemeral
      });
    }

    const noEntregados = items
      .filter(item => !entregados.includes(item.producto.nombre))
      .map(item => ({ producto: item.producto, cantidad: item.cantidad }));

    let estadoTexto = 'Partially Delivered';
    if (entregados.length === items.length) {
      estadoTexto = 'Delivered';
    } else if (entregados.length === 0) {
      estadoTexto = 'Canceled (Not Delivered)';
    }

    const deliveredItems = items.filter(item => entregados.includes(item.producto.nombre));

    const resumen = items.map(p => {
      const price = p.currency === 'UEC' ? `${formatUEC(p.producto.precioUEC)} UEC` : `$${formatUSD(p.producto.precioUSD)}`;
      return `• **${p.producto.nombre}** x${p.cantidad} - ${price}`;
    }).join('\n');

    await pedidoMessage.edit({
      content: `📥 **${pedidoMessage.content.split(' ')[1]}** placed an order:\n${resumen}\n**Status:** ${estadoTexto}${noEntregados.length > 0 ? ` (${noEntregados.map(item => item.producto.nombre).join(', ')} not delivered)` : ''}`,
      components: []
    });

    const userId = pedidoMessage.content.match(/\d+/)[0];
    try {
      const user = await client.users.fetch(userId);
      await user.send(`📦 **Order Update**\n${resumen}\n**Status:** ${estadoTexto}${noEntregados.length > 0 ? `\n**Not Delivered:** ${noEntregados.map(item => item.producto.nombre).join(', ')}` : ''}`);
    } catch (err) {
      console.error(`Could not send DM to user ${userId}:`, err);
    }

    if (deliveredItems.length > 0) {
      await publishSalesSummary(userId, deliveredItems, estadoTexto, deliveredItems[0].currency);
    }

    if (noEntregados.length > 0) {
      const canalAdmins = await client.channels.fetch('1358361940602257601');
      if (canalAdmins && canalAdmins.isTextBased()) {
        const resumenNoEntregados = noEntregados.map(p => {
          const price = p.currency === 'UEC' ? `${formatUEC(p.producto.precioUEC)} UEC` : `$${formatUSD(p.producto.precioUSD)}`;
          return `• **${p.producto.nombre}** x${p.cantidad} - ${price}`;
        }).join('\n');
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirmarTotal_${userId}_${pedidoMessage.id}`)
            .setLabel('✅ Confirm Full Delivery')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`confirmarParcial_${userId}_${pedidoMessage.id}`)
            .setLabel('📦 Confirm Partial Delivery')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`cancelar_${userId}_${pedidoMessage.id}`)
            .setLabel('❌ Cancel Order')
            .setStyle(ButtonStyle.Danger)
        );

        const nuevoPedidoMessage = await canalAdmins.send({
          content: `📥 **${pedidoMessage.content.split(' ')[1]}** has undelivered items from a previous order:\n${resumenNoEntregados}\n**Status:** Pending`,
          components: [row]
        });

        pedidosPendientes.set(userId, {
          items: noEntregados,
          pedidoMessageId: nuevoPedidoMessage.id
        });

        try {
          const user = await client.users.fetch(userId);
          await user.send(`📦 **New Pending Order Created**\nThe following items from your previous order were not delivered and have been moved to a new pending order:\n${resumenNoEntregados}\nWe will notify you once they are delivered.`);
        } catch (err) {
          console.error(`Could not send DM to user ${userId}:`, err);
        }
      }
    } else {
      pedidosPendientes.delete(userId);
    }

    estadosConfirmacion.delete(message.author.id);
    return message.reply({ content: '✅ Partial delivery confirmation completed.', flags: MessageFlags.Ephemeral });
  }
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  console.log(`Botón presionado: ${interaction.customId}`);

  const userId = interaction.user.id;
  const [accion, ...rest] = interaction.customId.split('_');
  const nombreProducto = rest[0] === 'uec' || rest[0] === 'usd' ? rest[1] : rest[0];
  const messageId = rest[rest.length - 1];
  const currency = accion === 'checkout_uec' ? 'UEC' : accion === 'checkout_usd' ? 'USD' : null;

  if (!accion || (!messageId && !['confirmarTotal', 'confirmarParcial', 'cancelar', 'notificar', 'confirmarPublicacion', 'cancelarPublicacion', 'update_sales'].includes(accion))) {
    return interaction.reply({ content: '❌ Invalid interaction. Please try again.', flags: MessageFlags.Ephemeral });
  }

  const esAdmin = interaction.member.permissions.has('Administrator');

  if (accion === 'update_sales') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can update the sales summary.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply({ ephemeral: true });
    await updateSalesEmbed();
    return interaction.editReply({ content: '✅ Sales summary updated!', flags: MessageFlags.Ephemeral });
  }

  if (accion === 'confirmarPublicacion') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can confirm publication.', flags: MessageFlags.Ephemeral });
    }

    const estadoPublicacion = estadosPublicacion.get(userId);
    if (!estadoPublicacion) {
      return interaction.reply({ content: '❌ No publication request found.', flags: MessageFlags.Ephemeral });
    }

    const { catalogos } = estadoPublicacion;

    // Defer the reply to avoid InteractionAlreadyReplied error
    await interaction.deferUpdate();

    let results = [];
    for (const catalogo of catalogos) {
      const result = await publishProducts(catalogo);
      results.push(result);
    }

    estadosPublicacion.delete(userId);
    return interaction.editReply({ content: `✅ Products published successfully!\n${results.join('\n')}`, components: [] });
  }

  if (accion === 'cancelarPublicacion') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can cancel publication.', flags: MessageFlags.Ephemeral });
    }

    estadosPublicacion.delete(userId);
    return interaction.update({ content: '✅ Publication canceled. You can publish later using `!publicarProductos <catalog>`.', components: [] });
  }

  const producto = await Producto.findOne({ nombre: nombreProducto });
  if (!producto && !['confirmarTotal', 'confirmarParcial', 'cancelar', 'notificar'].includes(accion)) {
    console.log(`Producto no encontrado: ${nombreProducto}`);
    return interaction.reply({ content: '❌ Product not found.', flags: MessageFlags.Ephemeral });
  }

  if (accion === 'agregar') {
    if (!producto.enStock) {
      return interaction.reply({ content: '❌ This product is out of stock.', flags: MessageFlags.Ephemeral });
    }

    if (!carritos.has(userId)) {
      carritos.set(userId, {});
    }

    const carrito = carritos.get(userId);

    if (!carrito[nombreProducto]) {
      carrito[nombreProducto] = { producto, cantidad: 1 };
    } else {
      carrito[nombreProducto].cantidad += 1;
    }
    carritos.set(userId, carrito);

    const updatedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`agregar_${producto.nombre}_${messageId}`)
        .setLabel(`➕ Add to Cart (x${carrito[nombreProducto].cantidad})`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`solicitar_${producto.nombre}_${messageId}`)
        .setLabel('📋 Request Product')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`checkout_uec_${producto.nombre}_${messageId}`)
        .setLabel('💰 Buy with UEC')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!producto.enStock || producto.precioUEC === 0),
      new ButtonBuilder()
        .setCustomId(`checkout_usd_${producto.nombre}_${messageId}`)
        .setLabel('💵 Buy with USD')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!producto.enStock || producto.precioUSD === 0)
    );

    const channel = await client.channels.fetch(interaction.channelId);
    const message = await channel.messages.fetch(messageId).catch(() => null);

    if (message) {
      if (message.author.id === client.user.id) {
        await message.edit({ components: [updatedRow] });
      } else {
        return interaction.reply({ content: '❌ I cannot edit this message because I did not create it.', flags: MessageFlags.Ephemeral });
      }
    } else {
      return interaction.reply({ content: '❌ The original message was not found.', flags: MessageFlags.Ephemeral });
    }

    const ephemeralMessageId = ephemeralMessages.get(userId);

    if (ephemeralMessageId) {
      try {
        await interaction.editReply({
          content: `🛒 **${producto.nombre}** in your cart: x${carrito[nombreProducto].cantidad}`,
          flags: MessageFlags.Ephemeral
        });
      } catch (err) {
        const newMessage = await interaction.reply({
          content: `🛒 **${producto.nombre}** in your cart: x${carrito[nombreProducto].cantidad}`,
          flags: MessageFlags.Ephemeral,
          withResponse: true
        });
        ephemeralMessages.set(userId, newMessage.id);
      }
    } else {
      const newMessage = await interaction.reply({
        content: `🛒 **${producto.nombre}** in your cart: x${carrito[nombreProducto].cantidad}`,
        flags: MessageFlags.Ephemeral,
        withResponse: true
      });
      ephemeralMessages.set(userId, newMessage.id);
    }
  }

  if (accion === 'solicitar') {
    if (producto.enStock) {
      return interaction.reply({ content: '❌ This product is already in stock. You can add it to your cart.', flags: MessageFlags.Ephemeral });
    }

    if (!listaEspera.has(producto.nombre)) {
      listaEspera.set(producto.nombre, []);
    }

    const usuariosEnEspera = listaEspera.get(producto.nombre);
    if (usuariosEnEspera.includes(userId)) {
      return interaction.reply({ content: '❌ You are already on the waiting list for this product.', flags: MessageFlags.Ephemeral });
    }

    usuariosEnEspera.push(userId);
    listaEspera.set(producto.nombre, usuariosEnEspera);

    const canalAdmins = await client.channels.fetch('1358361940602257601');
    if (canalAdmins && canalAdmins.isTextBased()) {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`notificar_${producto.nombre}_${interaction.message.id}`)
          .setLabel('📢 Notify Availability')
          .setStyle(ButtonStyle.Primary)
      );

      const solicitudMessage = await canalAdmins.send({
        content: `📋 **${interaction.user.tag}** has requested the product **${producto.nombre}** (Out of Stock).\nCurrent waiting list: ${usuariosEnEspera.map(id => `<@${id}>`).join(', ')}`,
        components: [row]
      });

      if (!listaEspera.has(`${producto.nombre}_messageId`)) {
        listaEspera.set(`${producto.nombre}_messageId`, solicitudMessage.id);
      }
    }

    return interaction.reply({ content: `✅ You have been added to the waiting list for **${producto.nombre}**. We will notify you when it is available.`, flags: MessageFlags.Ephemeral });
  }

  if (accion === 'notificar') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can notify availability.', flags: MessageFlags.Ephemeral });
    }

    const [, nombreProductoNotificar, solicitudMessageId] = interaction.customId.split('_');
    const producto = await Producto.findOne({ nombre: nombreProductoNotificar });
    if (!producto) {
      return interaction.reply({ content: '❌ Product not found.', flags: MessageFlags.Ephemeral });
    }

    producto.enStock = true;
    await producto.save();

    const usuariosEnEspera = listaEspera.get(producto.nombre) || [];
    for (const userId of usuariosEnEspera) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`📦 Great news, <@${userId}>! The product **${producto.nombre}** you requested is now in stock. You can purchase it in the channel <#${canalesCatalogos[producto.catalogo]}>.`);
      } catch (err) {
        console.error(`Could not notify user ${userId}:`, err);
      }
    }

    listaEspera.delete(producto.nombre);

    const channel = await client.channels.fetch(interaction.channelId);
    const message = await channel.messages.fetch(solicitudMessageId).catch(() => null);
    if (message) {
      await message.edit({
        content: `📋 **${message.content.split(' ')[1]}** has requested the product **${producto.nombre}**.\nCurrent waiting list: (None)`,
        components: []
      });
    }

    const canalProducto = await client.channels.fetch(canalesCatalogos[producto.catalogo]);
    if (canalProducto && canalProducto.isTextBased()) {
      const messages = await canalProducto.messages.fetch({ limit: 100 });
      const productoMessage = messages.find(msg => 
        msg.embeds[0]?.title === producto.nombre && msg.author.id === client.user.id
      );

      if (productoMessage) {
        const embed = EmbedBuilder.from(productoMessage.embeds[0])
          .spliceFields(2, 1)
          .addFields({ name: 'Status', value: producto.enStock ? 'In Stock ✅' : 'Out of Stock ❌', inline: true });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`agregar_${producto.nombre}_${productoMessage.id}`)
            .setLabel('➕ Add to Cart')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!producto.enStock),
          new ButtonBuilder()
            .setCustomId(`solicitar_${producto.nombre}_${productoMessage.id}`)
            .setLabel('📋 Request Product')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(producto.enStock),
          new ButtonBuilder()
            .setCustomId(`checkout_uec_${producto.nombre}_${productoMessage.id}`)
            .setLabel('💰 Buy with UEC')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!producto.enStock || producto.precioUEC === 0),
          new ButtonBuilder()
            .setCustomId(`checkout_usd_${producto.nombre}_${productoMessage.id}`)
            .setLabel('💵 Buy with USD')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!producto.enStock || producto.precioUSD === 0)
        );

        await productoMessage.edit({ embeds: [embed], components: [row] });
      }
    }

    return interaction.reply({ content: `✅ Users on the waiting list have been notified that **${producto.nombre}** is now in stock.`, flags: MessageFlags.Ephemeral });
  }

  if (accion === 'checkout_uec' || accion === 'checkout_usd') {
    try {
      console.log(`Intentando comprar con ${currency} para el usuario ${userId}`);
      await interaction.deferReply({ ephemeral: true });

      if (!carritos.has(userId)) {
        carritos.set(userId, {});
      }

      const carrito = carritos.get(userId);
      const items = Object.values(carrito);

      if (items.length === 0) {
        console.log(`Carrito vacío para el usuario ${userId}`);
        return interaction.editReply({ content: '🛒 Your cart is empty.' });
      }

      // Agregar la moneda seleccionada a los items del carrito
      items.forEach(item => {
        item.currency = currency;
      });

      const resumen = items.map(p => {
        const price = currency === 'UEC' ? `${formatUEC(p.producto.precioUEC)} UEC` : `$${formatUSD(p.producto.precioUSD)}`;
        return `• **${p.producto.nombre}** x${p.cantidad} - ${price}`;
      }).join('\n');

      console.log(`Resumen de la compra para ${userId}: ${resumen}`);

      await interaction.user.send({ content: `🧾 Your order (using ${currency}):\n${resumen}` });

      const canalAdmins = await client.channels.fetch('1358361940602257601');
      if (canalAdmins && canalAdmins.isTextBased()) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`confirmarTotal_${userId}_${interaction.message.id}`)
            .setLabel('✅ Confirm Full Delivery')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`confirmarParcial_${userId}_${interaction.message.id}`)
            .setLabel('📦 Confirm Partial Delivery')
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(`cancelar_${userId}_${interaction.message.id}`)
            .setLabel('❌ Cancel Order')
            .setStyle(ButtonStyle.Danger)
        );

        const pedidoMessage = await canalAdmins.send({
          content: `📥 **${interaction.user.tag}** placed an order (using ${currency}):\n${resumen}\n**Status:** Pending`,
          components: [row]
        });

        pedidosPendientes.set(userId, {
          items: items.map(item => ({ producto: item.producto, cantidad: item.cantidad, currency })),
          pedidoMessageId: pedidoMessage.id
        });
      } else {
        console.error('No se pudo encontrar o acceder al canal de admins (1358361940602257601).');
      }

      carritos.delete(userId);
      ephemeralMessages.delete(userId);

      const updatedRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`agregar_${producto.nombre}_${messageId}`)
          .setLabel('➕ Add to Cart')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(!producto.enStock),
        new ButtonBuilder()
          .setCustomId(`solicitar_${producto.nombre}_${messageId}`)
          .setLabel('📋 Request Product')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(producto.enStock),
        new ButtonBuilder()
          .setCustomId(`checkout_uec_${producto.nombre}_${messageId}`)
          .setLabel('💰 Buy with UEC')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!producto.enStock || producto.precioUEC === 0),
        new ButtonBuilder()
          .setCustomId(`checkout_usd_${producto.nombre}_${messageId}`)
          .setLabel('💵 Buy with USD')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!producto.enStock || producto.precioUSD === 0)
      );

      const channel = await client.channels.fetch(interaction.channelId);
      const message = await channel.messages.fetch(messageId).catch(() => null);

      if (message && message.author.id === client.user.id) {
        await message.edit({ components: [updatedRow] });
      }

      return interaction.editReply({ content: `✅ Order submitted using ${currency}. Check your private messages.` });
    } catch (err) {
      console.error(`Error al procesar la compra para ${userId}:`, err);
      return interaction.editReply({ content: '❌ I couldn’t send you a private message. Do you have DMs enabled?' });
    }
  }

  if (accion === 'confirmarTotal') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can confirm deliveries.', flags: MessageFlags.Ephemeral });
    }

    const [, userIdConfirm, pedidoMessageId] = interaction.customId.split('_');
    const pedido = pedidosPendientes.get(userIdConfirm);

    if (!pedido) {
      return interaction.reply({ content: '❌ Order data not found.', flags: MessageFlags.Ephemeral });
    }

    const channel = await client.channels.fetch(interaction.channelId);
    const pedidoMessage = await channel.messages.fetch(pedido.pedidoMessageId).catch(() => null);

    if (!pedidoMessage) {
      return interaction.reply({ content: '❌ The order message was not found.', flags: MessageFlags.Ephemeral });
    }

    const currency = pedido.items[0].currency;
    const resumen = pedido.items.map(p => {
      const price = currency === 'UEC' ? `${formatUEC(p.producto.precioUEC)} UEC` : `$${formatUSD(p.producto.precioUSD)}`;
      return `• **${p.producto.nombre}** x${p.cantidad} - ${price}`;
    }).join('\n');

    await pedidoMessage.edit({
      content: `📥 **${interaction.user.tag}** placed an order (using ${currency}):\n${resumen}\n**Status:** Delivered`,
      components: []
    });

    try {
      const user = await client.users.fetch(userIdConfirm);
      await user.send(`📦 **Order Update**\n${resumen}\n**Status:** Delivered`);
    } catch (err) {
      console.error(`Could not send DM to user ${userIdConfirm}:`, err);
    }

    await publishSalesSummary(userIdConfirm, pedido.items, 'Delivered', currency);

    pedidosPendientes.delete(userIdConfirm);
    return interaction.reply({ content: '✅ Full delivery confirmed.', flags: MessageFlags.Ephemeral });
  }

  if (accion === 'confirmarParcial') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can confirm deliveries.', flags: MessageFlags.Ephemeral });
    }

    const [, userIdConfirm, pedidoMessageId] = interaction.customId.split('_');
    const pedido = pedidosPendientes.get(userIdConfirm);

    if (!pedido) {
      return interaction.reply({ content: '❌ Order data not found.', flags: MessageFlags.Ephemeral });
    }

    const channel = await client.channels.fetch(interaction.channelId);
    const pedidoMessage = await channel.messages.fetch(pedido.pedidoMessageId).catch(() => null);

    if (!pedidoMessage) {
      return interaction.reply({ content: '❌ The order message was not found.', flags: MessageFlags.Ephemeral });
    }

    estadosConfirmacion.set(userIdConfirm, {
      pedidoMessage,
      items: pedido.items,
      entregados: []
    });

    return interaction.reply({
      content: `📦 Was **${pedido.items[0].producto.nombre}** delivered? Reply "yes" to confirm or "no" to skip:`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (accion === 'cancelar') {
    if (!esAdmin) {
      return interaction.reply({ content: '❌ Only administrators can cancel orders.', flags: MessageFlags.Ephemeral });
    }

    const [, userIdConfirm, pedidoMessageId] = interaction.customId.split('_');
    const pedido = pedidosPendientes.get(userIdConfirm);

    if (!pedido) {
      return interaction.reply({ content: '❌ Order data not found.', flags: MessageFlags.Ephemeral });
    }

    const channel = await client.channels.fetch(interaction.channelId);
    const pedidoMessage = await channel.messages.fetch(pedido.pedidoMessageId).catch(() => null);

    if (!pedidoMessage) {
      return interaction.reply({ content: '❌ The order message was not found.', flags: MessageFlags.Ephemeral });
    }

    const currency = pedido.items[0].currency;
    const resumen = pedido.items.map(p => {
      const price = currency === 'UEC' ? `${formatUEC(p.producto.precioUEC)} UEC` : `$${formatUSD(p.producto.precioUSD)}`;
      return `• **${p.producto.nombre}** x${p.cantidad} - ${price}`;
    }).join('\n');

    await pedidoMessage.edit({
      content: `📥 **${interaction.user.tag}** placed an order (using ${currency}):\n${resumen}\n**Status:** Canceled (Not Delivered)`,
      components: []
    });

    try {
      const user = await client.users.fetch(userIdConfirm);
      await user.send(`📦 **Order Canceled**\nYour order has been canceled by the administrator. Here are the details:\n${resumen}\nIf you have any questions, please contact the support team.`);
    } catch (err) {
      console.error(`Could not send DM to user ${userIdConfirm}:`, err);
    }

    pedidosPendientes.delete(userIdConfirm);
    return interaction.reply({ content: '✅ Order canceled.', flags: MessageFlags.Ephemeral });
  }
});

const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Bot running successfully.');
});

app.listen(3000, () => {
  console.log('Web server started on port 3000');
});
