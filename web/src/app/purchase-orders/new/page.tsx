import Breadcrumbs from '@mui/material/Breadcrumbs';
import Typography from '@mui/material/Typography';
import Link from 'next/link';
import { PurchaseOrderForm } from '@/components/PurchaseOrderForm';

export default function NewPurchaseOrderPage() {
  return (
    <>
      <Breadcrumbs sx={{ mb: 1 }}>
        <Link href="/purchase-orders" style={{ color: 'inherit' }}>
          Purchase orders
        </Link>
        <Typography color="text.primary">New</Typography>
      </Breadcrumbs>
      <Typography variant="h1" sx={{ mb: 3 }}>
        New purchase order
      </Typography>
      <PurchaseOrderForm />
    </>
  );
}
