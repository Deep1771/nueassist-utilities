function compareTree(userPermission,agencyPermission){
    let appArray = [];
    let userAccess = userPermission.apps && userPermission.apps.length;
    let agencyAccess = agencyPermission.apps && agencyPermission.apps.length;
    if (userAccess && agencyAccess) {
      userPermission.apps.map(app => {
        let appInAgency = agencyPermission.apps.find(a => a.name == app.name);
        if (appInAgency) {
          let Perms = compareAppTree(app, appInAgency);
          if (Perms) appArray.push(Perms);
        }
      });
      if (appArray.length) {
        userPermission.apps = appArray;
        return userPermission;
      } else return false;
    } else return false;
}
function compareAppTree(userAppData, agencyAppData){
    let modules = [],
      features = [];
    let userModuleAccess = userAppData.modules && userAppData.modules.length;
    let agencyModuleAccess =
      agencyAppData.modules && agencyAppData.modules.length;
    let userFeatAccess = userAppData.features && userAppData.features.length;
    let agencyFeatAccess =
      agencyAppData.features && agencyAppData.features.length;
    if (userModuleAccess && agencyModuleAccess) {
      userAppData.modules.map(mod => {
        let agencyModData = agencyAppData.modules.find(a => a.name == mod.name);
        if (agencyModData) {
          let appPerms = compareModuleTree(mod, agencyModData);
          if (appPerms) modules.push(appPerms);
        }
      });
    }
    if (userFeatAccess && agencyFeatAccess) {
      userAppData.features.map(feat => {
        let featureExists = agencyAppData.features.some(
          f => f.name == feat.name
        );
        if (featureExists) features.push(feat);
      });
    }
    if (!modules.length && !features.length) return false;
    else {
      if (modules.length) userAppData.modules = modules;
      else delete userAppData.modules;
      if (features.length) userAppData.features = features;
      else delete userAppData.features;
      return userAppData;
    }
  };

function compareModuleTree(userModData, agencyModData){
    let entityArray = [],accessObj = {};
    let userModAccess = userModData.entities && userModData.entities.length;
    let agencyModAccess = agencyModData.entities && agencyModData.entities.length;
    let agencyFlags = agencyModData.flags;
    let userFlags = userModData.flags;
    if(agencyFlags && userFlags){
      let agencyFlagKeys = Object.keys(agencyFlags);
      let userFlagKeys = Object.keys(userFlags);
      userFlagKeys.map(key => {
        let exists = agencyFlagKeys.some(k => k == key);
        if (exists) accessObj[key] = agencyFlags[key];
      });
      userModData.flags = accessObj
    }
    if (userModAccess && agencyModAccess) {
      userModData.entities.map(userEntity => {
        let agencyEntity = agencyModData.entities.find(
          e => e.name == userEntity.name
        );
        if (agencyEntity) {
          let tempTree = compareTemplateTree(userEntity, agencyEntity);
          if (tempTree) entityArray.push(tempTree);
        }
      });
      if (entityArray.length) {
        userModData.entities = entityArray;
        return userModData;
      } else return false;
    } else return false;
  };

  function compareTemplateTree(userEntitydata, agencyEntityData) {
    let accessObj = {},
      featObj = {};
    let userAccess =
      userEntitydata.topSectionArray && userEntitydata.topSectionArray.length;
    let agencyAccess = agencyEntityData.access && agencyEntityData.access.read;
    if (userAccess && agencyAccess) {
      // let agencyAccessKeys = Object.keys(agencyEntityData.access);
      // let accessObj = {...userEntitydata.access}
      // agencyAccessKeys.forEach(key => {
      //   let agencyAccess = agencyEntityData.access[key];
      //   if(agencyAccess === false) accessObj[key] = false
      // });
      // accessObj = { ...accessObj, 
      //   ...(agencyEntityData.access.visible == false && { visible :false }) }
      let agency = { ...agencyEntityData.access }
      let user = { ...userEntitydata.access }
  
      let accessObj = Object.keys(agency)
        .filter(key => key in user && agency[key] === user[key])
        .reduce((acc, key) => {
          acc[key] = agency[key];
          return acc;
        }, {});
      ['disableCreateOption'].forEach(key => {
        if ((key in agency === false) && key in user) {
          accessObj[key] = user[key];
        }
      });
      userEntitydata.access = accessObj;
      userEntitydata = { ...userEntitydata, friendlyName: agencyEntityData.friendlyName };
      if (agencyEntityData.featureAccess && userEntitydata.featureAccess) {
        let agencyFeatKeys = Object.keys(agencyEntityData.featureAccess);
        let userFeatKeys = Object.keys(userEntitydata.featureAccess);
        if (agencyFeatKeys.length && userFeatKeys.length) {
          userFeatKeys.map(key => {
            let exists = agencyFeatKeys.some(k => k == key);
            if (exists) featObj[key] = true;
          });
        }
        if (Object.keys(featObj).length) userEntitydata.featureAccess = featObj;
        else delete userEntitydata['featureAccess'];
      }
      if (agencyEntityData.approval)
        userEntitydata.approval = true
      else delete userEntitydata.approval
  
      userEntitydata.topSectionArray = getEntityAttributes(
        userEntitydata.topSectionArray,
        agencyEntityData.topSectionArray
      );
      userEntitydata.componentArray = getEntityAttributes(
        userEntitydata.componentArray,
        agencyEntityData.componentArray
      );
      if (!userEntitydata.componentArray.length)
        delete userEntitydata.componentArray;
      userEntitydata.topValidationArray = getValidationAttributes(
        userEntitydata.topValidationArray,
        agencyEntityData.topValidationArray
      );
      if (!userEntitydata.topValidationArray.length)
        delete userEntitydata.topValidationArray;
      userEntitydata.componentValidationArray = getValidationAttributes(
        userEntitydata.componentValidationArray,
        agencyEntityData.componentValidationArray
      );
      if (!userEntitydata.componentValidationArray.length)
        delete userEntitydata.componentValidationArray;
      if (
        userEntitydata.topSectionArray &&
        userEntitydata.topSectionArray.length
      )
        return userEntitydata;
      else return false;
    } else return false;
  };

 function compareSectionTree(userPerm, agencyPerm, validationFlag){
    let fieldArr = [];
    let userFieldAccess = userPerm.fields && userPerm.fields.length;
    let agencyFieldAccess = agencyPerm.fields && agencyPerm.fields.length;
    if (userFieldAccess && agencyFieldAccess) {
      userPerm.fields.map(field => {
        let agencyField = agencyPerm.fields.find(f => f.name == field.name);
        if (agencyField) {
          if (validationFlag) fieldArr.push(field);
          else {
            let fieldPerm = compareFields(field, agencyField);
            if (fieldPerm) fieldArr.push(fieldPerm);
          }
        }
      });
      if (fieldArr.length) {
        userPerm.fields = fieldArr;
        return userPerm;
      } else return false;
    } else return false;
  };

function compareFields(userPerm, agencyPerm){
    let accessObj = {};
    let userReadAccess = userPerm.access && userPerm.access.read;
    let agencyReadAccess = agencyPerm.access && agencyPerm.access.read;
    if (userReadAccess && agencyReadAccess) {
      let agencyAccessKeys = Object.keys(agencyPerm.access);
      let userAccessKeys = Object.keys(userPerm.access);
      userAccessKeys.map(key => {
        let exists = agencyAccessKeys.some(k => k == key);
        if (exists) accessObj[key] = true;
      });
      userPerm.access = accessObj;
      return userPerm;
    } else return false;
  };

  function getEntityAttributes(userAttributes, agencyAttributes) {
    let SectionArray = [];
    if (
      userAttributes &&
      userAttributes.length &&
      agencyAttributes &&
      agencyAttributes.length
    ) {
      userAttributes.map(section => {
        let agencySection = agencyAttributes.find(
          sec => sec.name == section.name
        );
        if (agencySection) {
          let secPerm = compareSectionTree(section, agencySection);
          SectionArray.push(secPerm);
        }
      });
    }
    return SectionArray;
  }

  function getValidationAttributes(userAttributes, agencyAttributes) {
    let ValidationArray = [];
    if (
      userAttributes &&
      userAttributes.length &&
      agencyAttributes &&
      agencyAttributes.length
    ) {
      userAttributes.map(valid => {
        let agencyValidation = agencyAttributes.find(v => v.name == valid.name);
        if (agencyValidation) {
          let valPerm = compareSectionTree(valid, agencyValidation, true);
          if (valPerm) ValidationArray.push(valPerm);
        }
      });
    }
    return ValidationArray;
  }
module.exports = {
    compareTree,
    compareAppTree,
    compareModuleTree,
    compareTemplateTree,
    compareSectionTree,
    compareFields
}
