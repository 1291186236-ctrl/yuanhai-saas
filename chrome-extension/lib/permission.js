// lib/permission.js
// 会员等级权限控制

(function (global) {
  'use strict';

  const PLAN_FEATURES = {
    free: {
      canExport: false,
      canResume: false,
      canCustomSites: false,
      canTeamShare: false,
      maxProducts: 5,
      maxImages: 10,
      maxTemplates: 1,
      unlimitedQuota: false
    },
    pro: {
      canExport: true,
      canResume: true,
      canCustomSites: false,
      canTeamShare: false,
      maxProducts: Infinity,
      maxImages: Infinity,
      maxTemplates: Infinity,
      unlimitedQuota: true
    },
    enterprise: {
      canExport: true,
      canResume: true,
      canCustomSites: true,
      canTeamShare: true,
      maxProducts: Infinity,
      maxImages: Infinity,
      maxTemplates: Infinity,
      unlimitedQuota: true
    }
  };

  const PLAN_DISPLAY = {
    free: { name: '免费版', color: '#888', icon: '🆓' },
    pro: { name: '专业版', color: '#f59e0b', icon: '⭐' },
    enterprise: { name: '企业版', color: '#7c3aed', icon: '💎' }
  };

  const Permission = {
    getFeatures(plan) {
      return PLAN_FEATURES[plan] || PLAN_FEATURES.free;
    },

    getDisplay(plan) {
      return PLAN_DISPLAY[plan] || PLAN_DISPLAY.free;
    },

    can(plan, feature) {
      const f = this.getFeatures(plan);
      return !!f[feature];
    },

    canUseFeature(plan, feature) {
      if (!plan) return false;
      const features = this.getFeatures(plan);
      return !!features[feature];
    },

    checkProductCount(plan, count) {
      const f = this.getFeatures(plan);
      if (f.maxProducts === Infinity) return { ok: true };
      if (count > f.maxProducts) {
        return { ok: false, reason: 'PRODUCT_LIMIT', limit: f.maxProducts };
      }
      return { ok: true };
    },

    checkImageCount(plan, count) {
      const f = this.getFeatures(plan);
      if (f.maxImages === Infinity) return { ok: true };
      if (count > f.maxImages) {
        return { ok: false, reason: 'IMAGE_LIMIT', limit: f.maxImages };
      }
      return { ok: true };
    },

    checkTemplateCount(plan, count) {
      const f = this.getFeatures(plan);
      if (f.maxTemplates === Infinity) return { ok: true };
      if (count > f.maxTemplates) {
        return { ok: false, reason: 'TEMPLATE_LIMIT', limit: f.maxTemplates };
      }
      return { ok: true };
    },

    getUpgradeReason(feature) {
      const reasons = {
        canExport: '导出 Excel 结果需要 Pro 版',
        canResume: '断点续传需要 Pro 版',
        canCustomSites: '自定义网站支持需要 Enterprise 版',
        canTeamShare: '团队模板共享需要 Enterprise 版',
        PRODUCT_LIMIT: '免费版最多处理 5 个商品，升级 Pro 解锁无限',
        IMAGE_LIMIT: '免费版每商品最多 10 张图，升级 Pro 解锁无限',
        TEMPLATE_LIMIT: '免费版仅支持 1 个模板，升级 Pro 解锁无限'
      };
      return reasons[feature] || '此功能需要升级会员';
    },

    PLAN_FEATURES,
    PLAN_DISPLAY
  };

  global.Permission = Permission;
})(typeof window !== 'undefined' ? window : self);
