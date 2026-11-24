import app from './app.js';
import { migrate } from './migrate.js';

const PORT = Number(process.env.PORT || 4000);
await migrate();
app.listen(PORT, () => console.log(`Crewline API listening on http://localhost:${PORT}`));
