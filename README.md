# API SimpleRCV - THO

Integración con SimpleAPI para traer facturas del SII automáticamente.

## Deploy

1. Sube esta carpeta a GitHub: `api-simple-rcv-tho`
2. Importa en Vercel desde GitHub
3. Configura variables de entorno:
   - `SIMPLEAPI_KEY`: 7441-R860-6393-4871-0231
   - `SII_RUT`: 76.XXX.XXX-X (RUT de THO)
   - `SUPABASE_URL`: https://bepifbenblkqjuplvylh.supabase.co
   - `SUPABASE_KEY`: [tu anon key]
4. Deploy

## Endpoint

`POST /api/simple-rcv`

Body:
```json
{
  "periodo": "2026-01",
  "userEmail": "jere@tho.cl"
}
```

## ¡Listo!

Mucho más simple que integrar directo con el SII.
