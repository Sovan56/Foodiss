import React, { useMemo } from 'react';
import { motion } from 'framer-motion';
import discountPromoIcon from "@food/assets/category-icons/discount_promo.png";
import gourmetPromoIcon from "@food/assets/explore more icons/gourmet.png";
import pricePromoIcon from "@food/assets/category-icons/price_promo.png";
import collectionPromoIcon from "@food/assets/explore more icons/collection.png";

const DEFAULT_PROMO_ITEMS = [
  {
    id: 'offers',
    title: "Hot Deals",
    label: "Offers",
    image: discountPromoIcon,
    href: '/food/user/offers',
  },
  {
    id: 'grocery',
    title: "Fresh Groceries",
    label: "Grocery",
    image: "https://images.unsplash.com/vector-1763382329927-1b1f16b5b5aa?fm=png&q=80&w=256&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D",
    href: 'https://grocery.foodiss.in/',
  },
  {
    id: 'gourmet',
    title: "Premium",
    label: "Gourmet",
    image: gourmetPromoIcon,
    href: '/food/user/gourmet',
  },
  {
    id: 'under-250',
    title: "Under ₹99",
    label: "Switch 99",
    image: pricePromoIcon,
    href: '/food/user/under-250',
  },
  {
    id: 'collections',
    title: "Favorites",
    label: "Collections",
    image: collectionPromoIcon,
    href: '/food/user/profile/favorites',
  },
];

export default function PromoRow({ items, navigate, toggleRef }) {
  const promoCardsData = useMemo(() => {
    const source = Array.isArray(items) && items.length > 0 ? items : DEFAULT_PROMO_ITEMS;

    return source.map((item) => ({
      id: item.id,
      title: item.title || DEFAULT_PROMO_ITEMS.find((slot) => slot.id === item.id)?.title || "",
      value: item.label || item.value || "",
      icon: item.image || item.icon,
      href: item.href,
    }));
  }, [items]);

  return (
    <div className="grid grid-cols-5 gap-2 px-3 py-6 bg-transparent justify-items-center w-full max-w-[500px] mx-auto">
      {promoCardsData.map((promo, idx) => (
        <motion.div
          key={promo.id || idx}
          ref={promo.id === 'gourmet' ? toggleRef : null}
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: idx * 0.05, duration: 0.4, ease: [0.25, 0.1, 0.25, 1] }}
          whileHover={{ y: -4 }}
          whileTap={{ scale: 0.95 }}
          className="flex flex-col items-center gap-1.5 group cursor-pointer w-full"
          onClick={() => {
            if (!promo.href) return;
            if (/^https?:\/\//i.test(promo.href)) {
              window.open(promo.href, '_blank');
            } else {
              navigate(promo.href);
            }
          }}
        >
          <div className="relative flex aspect-square w-14 shrink-0 items-center justify-center sm:w-16">
            <img
              src={promo.icon}
              alt={promo.value}
              className="h-full w-full object-contain object-center transition-transform duration-500 group-hover:scale-110 drop-shadow-sm"
            />
          </div>

          <div className="flex flex-col items-center text-center w-full">
            <span className="text-[12px] font-black text-gray-900 dark:text-gray-100 tracking-tight leading-tight mb-0.5">
              {promo.value}
            </span>
            <span className="text-[9px] font-bold text-gray-500 dark:text-gray-400 capitalize whitespace-nowrap">
              {promo.title}
            </span>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
