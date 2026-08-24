# Mexican cartels form a network of alliances and rivalries
---
Datasets and code to analyse the recruitment of organised crime groups in Mexico. The repository has four data sources and an R code to analyse the results of the model.

## Description of the data and file structure

The dataset consists of four tables, stored in a csv format. They are:
  * BACRIM2020_Nodes.csv
  * BACRIM2020_Alliances.csv
  * BACRIM2020_Rivals.csv
  * Trends2012_2021.csv

The corresponding structure for each of the files is:
  * BACRIM2020_Nodes.csv
-Node: a unique ID for each identified cartel in Mexico
-Group: the name with which a cartel is frequently named
-State: one of the states in which the cartel has been active. 
-ShortName: short version of the cartel name

  * BACRIM2020_Alliances.csv
-Edge: unique identifier for the corresponding edge. 
-Node: the ID of one of the allied cartels
-Group: name of the cartel
-RNode: the ID of the second allied cartel
-RGroup: name of the second allied cartel
-weight: number of states in which the two cartels are allied

  * BACRIM2020_Rivals.csv
-Edge: unique identifier for the corresponding edge. 
-Node: the ID of one of the fighting cartels
-Group: name of the cartel
-RNode: the ID of the second cartel
-RGroup: name of the second cartel
-weight: number of states in which the two cartels were fighting in 2020

  * Trends2012_2021.csv
-YEAR: numeric between 2012 and 2021
-homicide: number of homicides by year
-missings: number of missing people by year
-arrests: number of incarcerated people by year


## Sharing/Access information
Data was derived from the following sources:
  * CentroGeo, GeoInt and DataLab, part of Consejo Nacional de Ciencia y Tecnología. Data related to cartels in Mexico in 2020 was obtained from open sources, including national and local newspapers and narco blogs. 
    The source of the data is here: https://ppdata.politicadedrogas.org/

## Code/Software
  * The repository includes an R code called ReclutamientoC.R
    The code takes the two matrices as an input and produces an estimate of cartel size and distribution. It produces also the number of murders and incapacitations by week. 
    The model takes the 2012-2022 decade. 
    It relies on the following libraries to obtain the results:
    bvpSolve
    igraph
    nloptr


