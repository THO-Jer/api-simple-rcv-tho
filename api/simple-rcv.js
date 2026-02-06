/**
 * Vercel Serverless Function: Sincronizar facturas usando SimpleAPI RCV
 * 
 * Path: /api/simple-rcv.js
 * 
 * SimpleAPI RCV es un servicio intermediario que consulta el RCV del SII
 * y devuelve los datos en formato JSON limpio y estructurado.
 */

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

async function getUFActual() {
    const { data } = await supabase
        .from('uf_valores')
        .select('valor')
        .order('fecha', { ascending: false })
        .limit(1)
        .single();
    
    return data?.valor || 38000;
}

/**
 * Consultar RCV completo usando SimpleAPI
 * Devuelve tanto ventas como compras en una sola llamada
 */
async function consultarRCV(mes, año, credentials) {
    // SimpleAPI usa un endpoint único que devuelve ventas Y compras
    const url = `https://servicios.simpleapi.cl/api/RCV/ventas/${mes}/${año}`;
    
    const body = {
        RutUsuario: credentials.rutUsuario,
        PasswordSII: credentials.passwordSII,
        RutEmpresa: credentials.rutEmpresa,
        Ambiente: 1 // 1 = producción
    };
    
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': credentials.apiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    
    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Error SimpleAPI: ${response.status} - ${error}`);
    }
    
    const data = await response.json();
    
    // La estructura es: { ventas: { detalleVentas: [...] }, compras: { detalleCompras: [...] } }
    return {
        ventas: data.ventas?.detalleVentas || [],
        compras: data.compras?.detalleCompras || []
    };
}

/**
 * Procesar facturas emitidas
 */
async function procesarFacturasEmitidas(documentos, ufActual) {
    let nuevos = 0;
    let actualizados = 0;
    const errores = [];
    
    for (const doc of documentos) {
        try {
            const factura = {
                numero_folio: doc.folio,
                cliente: doc.razonSocial || 'Cliente',
                rut_cliente: doc.rutCliente,
                fecha_emision: doc.fechaEmision?.split('T')[0] || null, // Convertir ISO a YYYY-MM-DD
                monto_clp: doc.montoTotal,
                monto_uf: Math.round((doc.montoTotal / ufActual) * 100) / 100,
                estado: doc.estado || 'Emitida',
                origen: 'SimpleAPI',
                tipo_documento: doc.tipoDTE,
                actualizado_sii: new Date().toISOString()
            };
            
            const { data: existe } = await supabase
                .from('facturas_emitidas')
                .select('id')
                .eq('numero_folio', doc.folio)
                .eq('origen', 'SimpleAPI')
                .single();
            
            if (existe) {
                await supabase
                    .from('facturas_emitidas')
                    .update({
                        monto_clp: factura.monto_clp,
                        monto_uf: factura.monto_uf,
                        actualizado_sii: factura.actualizado_sii
                    })
                    .eq('id', existe.id);
                actualizados++;
            } else {
                const { error } = await supabase
                    .from('facturas_emitidas')
                    .insert([factura]);
                
                if (error) {
                    errores.push(`Folio ${doc.folio}: ${error.message}`);
                } else {
                    nuevos++;
                }
            }
        } catch (error) {
            errores.push(`Folio ${doc.folio}: ${error.message}`);
        }
    }
    
    return { nuevos, actualizados, errores };
}

/**
 * Procesar facturas recibidas
 */
async function procesarFacturasRecibidas(documentos, ufActual) {
    let nuevos = 0;
    let actualizados = 0;
    const errores = [];
    
    for (const doc of documentos) {
        try {
            const factura = {
                numero_folio: doc.folio,
                proveedor: doc.razonSocial || 'Proveedor',
                rut_proveedor: doc.rutProveedor,
                fecha_emision: doc.fechaEmision?.split('T')[0] || null, // Convertir ISO a YYYY-MM-DD
                monto_clp: doc.montoTotal,
                monto_uf: Math.round((doc.montoTotal / ufActual) * 100) / 100,
                estado: doc.estado || 'Recibida',
                origen: 'SimpleAPI',
                tipo_documento: doc.tipoDTE,
                categoria: 'Servicios',
                actualizado_sii: new Date().toISOString()
            };
            
            const { data: existe } = await supabase
                .from('facturas_recibidas')
                .select('id')
                .eq('numero_folio', doc.folio)
                .eq('origen', 'SimpleAPI')
                .single();
            
            if (existe) {
                await supabase
                    .from('facturas_recibidas')
                    .update({
                        monto_clp: factura.monto_clp,
                        monto_uf: factura.monto_uf,
                        actualizado_sii: factura.actualizado_sii
                    })
                    .eq('id', existe.id);
                actualizados++;
            } else {
                const { error } = await supabase
                    .from('facturas_recibidas')
                    .insert([factura]);
                
                if (error) {
                    errores.push(`Folio ${doc.folio}: ${error.message}`);
                } else {
                    nuevos++;
                }
            }
        } catch (error) {
            errores.push(`Folio ${doc.folio}: ${error.message}`);
        }
    }
    
    return { nuevos, actualizados, errores };
}

async function registrarSync(tipo, periodo, resultado, userEmail) {
    await supabase
        .from('sii_sync_log')
        .insert([{
            tipo_sync: tipo,
            periodo: periodo,
            documentos_nuevos: resultado.nuevos,
            documentos_actualizados: resultado.actualizados,
            errores: resultado.errores.length > 0 ? resultado.errores.join('; ') : null,
            estado: resultado.errores.length > 0 ? 'parcial' : 'exitoso',
            usuario_email: userEmail
        }]);
}

/**
 * Handler principal
 */
module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    
    try {
        if (req.method !== 'POST') {
            return res.status(405).json({ error: 'Método no permitido' });
        }
        
        const { periodo, userEmail } = req.body;
        
        if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
            return res.status(400).json({
                error: 'Parámetro "periodo" requerido (formato: YYYY-MM)'
            });
        }
        
        const [año, mes] = periodo.split('-');
        
        const credentials = {
            apiKey: process.env.SIMPLEAPI_KEY,
            rutUsuario: process.env.SII_RUT_USUARIO,
            passwordSII: process.env.SII_PASSWORD,
            rutEmpresa: process.env.SII_RUT_EMPRESA
        };
        
        const ufActual = await getUFActual();
        
        // SimpleAPI devuelve AMBAS (ventas y compras) en una sola llamada
        console.log('Consultando RCV (ventas y compras)...');
        const rcv = await consultarRCV(mes, año, credentials);
        
        let resultadoEmitidas = { nuevos: 0, actualizados: 0, errores: [] };
        const ventasArray = rcv?.ventas || [];
        if (ventasArray.length > 0) {
            resultadoEmitidas = await procesarFacturasEmitidas(ventasArray, ufActual);
            await registrarSync('facturas_emitidas', periodo, resultadoEmitidas, userEmail);
        }
        
        let resultadoRecibidas = { nuevos: 0, actualizados: 0, errores: [] };
        const comprasArray = rcv?.compras || [];
        if (comprasArray.length > 0) {
            resultadoRecibidas = await procesarFacturasRecibidas(comprasArray, ufActual);
            await registrarSync('facturas_recibidas', periodo, resultadoRecibidas, userEmail);
        }
        
        return res.status(200).json({
            success: true,
            periodo: periodo,
            uf_utilizada: ufActual,
            emitidas: {
                total: ventasArray.length,
                nuevas: resultadoEmitidas.nuevos,
                actualizadas: resultadoEmitidas.actualizados,
                errores: resultadoEmitidas.errores
            },
            recibidas: {
                total: comprasArray.length,
                nuevas: resultadoRecibidas.nuevos,
                actualizadas: resultadoRecibidas.actualizados,
                errores: resultadoRecibidas.errores
            },
            message: `Sincronización completada: ${resultadoEmitidas.nuevos + resultadoRecibidas.nuevos} nuevas, ${resultadoEmitidas.actualizados + resultadoRecibidas.actualizados} actualizadas`
        });
        
    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
};

/**
 * VARIABLES DE ENTORNO NECESARIAS:
 * 
 * - SIMPLEAPI_KEY: 7441-R860-6393-4871-0231
 * - SII_RUT_USUARIO: Tu RUT personal (formato: 12345678-9)
 * - SII_PASSWORD: Tu clave del SII
 * - SII_RUT_EMPRESA: 76.XXX.XXX-X (RUT de THO)
 * - SUPABASE_URL
 * - SUPABASE_KEY
 */
